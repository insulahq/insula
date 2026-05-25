/**
 * DR bundle reader (Unit B.1).
 *
 * Consumes an A2-format secrets-bundle.tar.age and returns the parsed
 * sidecars + a list of every Secret YAML inside. The bundle MUST have
 * been produced by A2 or later — older bundles lack the sidecars and
 * surface as BundleVersionError → LegacyBundleError so the importer
 * can degrade gracefully ("Secrets-only restore; DR addressing must
 * be reconfigured manually").
 *
 * Mirrors the `age` spawn pattern in secrets-bundle.ts:ageEncrypt
 * (using the OS `age` binary rather than a pure-JS port). The age
 * private key is consumed via the `-i` file flag — the caller passes
 * a path, NEVER the key bytes, to keep the secret out of argv and
 * out of the platform-api process memory by default.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as tar from 'tar-stream';
import { Readable } from 'node:stream';
import {
  parseDrInputs,
  parseDrRows,
  BundleVersionError,
} from '../system-backup/dr-sidecars.js';
import type { DrInputs, DrRows } from '@k8s-hosting/api-contracts';

export class LegacyBundleError extends Error {
  constructor(reason: string) {
    super(
      `Bundle predates A2 (no dr-inputs.yaml / dr-rows.json): ${reason}. `
      + 'Secrets-only restore is still possible via `make secrets-restore`; '
      + 'backup targets must be reconfigured manually after the cluster comes up.',
    );
    this.name = 'LegacyBundleError';
  }
}

export class BundleDecryptError extends Error {
  constructor(reason: string) {
    super(`Failed to decrypt bundle: ${reason}`);
    this.name = 'BundleDecryptError';
  }
}

export interface BundleSecretYaml {
  readonly filename: string;
  readonly content: Buffer;
}

export interface ReadBundleResult {
  readonly drInputs: DrInputs;
  readonly drRows: DrRows;
  /** Every Secret YAML payload in the tar (one entry per
   *  `<namespace>__<name>.yaml`). Unit B doesn't apply these — it
   *  leaves Secret restoration to the existing `make secrets-restore`
   *  path. We surface them so a caller could verify completeness. */
  readonly secretYamls: ReadonlyArray<BundleSecretYaml>;
  /** Pass-through of the v2 MANIFEST.json bytes (machine-readable
   *  audit trail of what's in the bundle). Useful for the harness. */
  readonly manifestJson: Buffer;
}

export interface ReadBundleOpts {
  readonly bundlePath: string;
  readonly ageKeyPath: string;
  readonly ageBinary?: string;
}

/**
 * Read a bundle end-to-end: age decrypt → tar extract → parse sidecars.
 *
 * Throws:
 *   - `BundleDecryptError` if age fails (wrong key / corrupted file)
 *   - `LegacyBundleError` if the sidecars are missing (pre-A2 bundle)
 *   - `BundleVersionError` if the sidecar drBundleVersion is unknown
 *     (we keep this distinct from legacy so the importer surfaces
 *     a different message — "future bundle, upgrade platform first")
 */
export async function readBundle(opts: ReadBundleOpts): Promise<ReadBundleResult> {
  const ageBinary = opts.ageBinary ?? 'age';
  const bundleBytes = await readFile(opts.bundlePath);

  // ── age decrypt via subprocess pipe ────────────────────────────────
  const tarBytes = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(ageBinary, ['-d', '-i', opts.ageKeyPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    proc.on('error', (e) => reject(new BundleDecryptError(e.message)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new BundleDecryptError(
          `age exit ${code}: ${Buffer.concat(err).toString('utf8').trim() || 'no stderr'}`,
        ));
        return;
      }
      resolve(Buffer.concat(out));
    });
    proc.stdin.end(bundleBytes);
  });

  // ── tar extract ────────────────────────────────────────────────────
  const entries = await extractTar(tarBytes);

  const drInputsRaw = entries.find((e) => e.filename === 'dr-inputs.yaml');
  const drRowsRaw = entries.find((e) => e.filename === 'dr-rows.json');
  const manifestJson = entries.find((e) => e.filename === 'MANIFEST.json');

  if (!manifestJson) {
    // Even pre-A2 bundles carry MANIFEST.json. Absence here means
    // the tar is malformed (or someone unpacked + repacked it badly).
    throw new BundleDecryptError(
      'tar archive missing MANIFEST.json — bundle structure is invalid',
    );
  }

  if (!drInputsRaw || !drRowsRaw) {
    throw new LegacyBundleError(
      drInputsRaw ? 'dr-rows.json missing' : 'dr-inputs.yaml missing',
    );
  }

  // ── parse + version-check sidecars ─────────────────────────────────
  // parseDrInputs / parseDrRows throw BundleVersionError if the
  // drBundleVersion field doesn't match this build's expectation.
  // We let that propagate — it's a distinct error class from legacy.
  let drInputs: DrInputs;
  let drRows: DrRows;
  try {
    drInputs = parseDrInputs(drInputsRaw.content);
  } catch (err) {
    if (err instanceof BundleVersionError) throw err;
    throw new BundleDecryptError(`dr-inputs.yaml parse error: ${(err as Error).message}`);
  }
  try {
    drRows = parseDrRows(drRowsRaw.content);
  } catch (err) {
    if (err instanceof BundleVersionError) throw err;
    throw new BundleDecryptError(`dr-rows.json parse error: ${(err as Error).message}`);
  }

  // ── collect Secret YAML files (informational; Unit B doesn't apply) ─
  const secretYamls: BundleSecretYaml[] = entries.filter(
    (e) => e.filename.endsWith('.yaml')
      && e.filename !== 'dr-inputs.yaml'
      && !e.filename.startsWith('MANIFEST'),
  );

  return {
    drInputs,
    drRows,
    secretYamls,
    manifestJson: manifestJson.content,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface TarEntry {
  readonly filename: string;
  readonly content: Buffer;
}

async function extractTar(bytes: Buffer): Promise<TarEntry[]> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const entries: TarEntry[] = [];
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        entries.push({ filename: header.name, content: Buffer.concat(chunks) });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    extract.on('finish', () => resolve(entries));
    extract.on('error', reject);
    Readable.from(bytes).pipe(extract);
  });
}
