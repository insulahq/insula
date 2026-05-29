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
import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar-stream';
import { Readable } from 'node:stream';
import {
  parseDrInputs,
  parseDrRows,
  BundleVersionError,
} from '../system-backup/dr-sidecars.js';
import type { DrInputs, DrRows } from '@insula/api-contracts';

// Hard upper bound on the encrypted bundle size. A legitimate bundle
// is a few hundred KB (Secrets YAMLs + sidecars). The cap exists to
// stop a corrupt or adversarial multi-GB file from OOM'ing the import
// process before the operator can intervene (security review M-S1).
// 512 MiB chosen as ~1000× the largest realistic bundle.
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

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

  // ── 1. Bundle size pre-check (security review M-S1) ───────────────
  const st = await stat(opts.bundlePath);
  if (st.size > MAX_BUNDLE_BYTES) {
    throw new BundleDecryptError(
      `bundle file exceeds ${MAX_BUNDLE_BYTES} bytes (${st.size}) — refusing to load to prevent OOM`,
    );
  }
  if (st.size === 0) {
    throw new BundleDecryptError('bundle file is empty');
  }

  // ── 2. Optional --age-binary validation (security review L-S4) ─────
  // Validate ONLY when the operator supplied a non-default path. The
  // default 'age' is resolved via PATH by spawn(), which we trust.
  if (opts.ageBinary) {
    try {
      await access(ageBinary, fsConstants.X_OK);
    } catch {
      throw new BundleDecryptError(
        `--age-binary ${ageBinary} is not an executable file`,
      );
    }
  }

  const bundleBytes = await readFile(opts.bundlePath);

  // ── 3. age decrypt via subprocess pipe ─────────────────────────────
  // EPIPE protection (TS review HIGH-1): when `age` exits early (wrong
  // key, malformed header), it closes stdin before we finish writing.
  // For bundles >64 KB (the OS pipe buffer), Node.js then raises EPIPE
  // on proc.stdin and — without an 'error' listener — converts the
  // stream error into an uncaught exception that crashes the process.
  // Swallow it: the 'close' handler below already rejects with the
  // meaningful error from age's stderr.
  const tarBytes = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(ageBinary, ['-d', '-i', opts.ageKeyPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    proc.stdin.on('error', () => { /* see EPIPE note above */ });
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
        // Security review L-S5: normalise the tar entry name to its
        // basename + reject path traversal sequences. Unit B doesn't
        // write entries to disk (only returns the array), but Unit C
        // might — locking the contract now prevents a future restore
        // pipeline from being tricked by `../../etc/passwd` entries.
        const raw = header.name;
        const base = path.basename(raw);
        if (!base || base.includes('..') || path.isAbsolute(raw)) {
          // Adversarial entry — skip silently so a normal bundle
          // with a single bad entry doesn't take out the whole read.
          next();
          return;
        }
        entries.push({ filename: base, content: Buffer.concat(chunks) });
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
