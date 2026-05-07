/**
 * GDPR data-export wrapper for tenant bundles.
 *
 * After a successful bundle capture (post-meta.json), the orchestrator
 * may invoke `wrapBundleAsDataExport` to produce a single
 * passphrase-encrypted tarball at:
 *
 *   components/export/<backupId>.tar.gz.enc
 *
 * containing every other component artifact + meta.json. The client
 * downloads this file via the data-export download endpoint and
 * decrypts locally with the passphrase they supplied at create time.
 *
 * Why this design:
 *   - The platform NEVER stores the passphrase. It is hashed for
 *     downstream comparison only if we later want a "verify the
 *     passphrase before download" flow; for now it's used once to
 *     encrypt and discarded.
 *   - One artifact = one download. Operators don't have to reason
 *     about per-component download URLs or stitch tarballs back
 *     together.
 *   - AES-256-CBC + PBKDF2 (100k rounds, sha256) matches `openssl enc
 *     -aes-256-cbc -pbkdf2 -iter 100000` so the client can decrypt
 *     with stock openssl on any platform:
 *
 *       openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
 *         -in <backupId>.tar.gz.enc -out <backupId>.tar.gz \
 *         -pass stdin <<< "$PASSPHRASE"
 *
 * Format: matches OpenSSL's "Salted__" envelope:
 *   "Salted__" (8 bytes) || salt (8 bytes) || ciphertext
 * The ciphertext is the AES-256-CBC encryption of the gzipped tar
 * stream, with key+IV derived via PBKDF2(passphrase, salt, 100k,
 * sha256, 48 bytes) split into 32-byte key and 16-byte IV.
 *
 * Ciphertext stays opaque — the platform cannot read its contents
 * without re-deriving the key from the passphrase the client
 * supplied at create time.
 */

import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pack as tarPack, extract as tarExtract } from 'tar-stream';
import type { BackupStore, BundleHandle } from './bundle-store.js';

const PBKDF2_ITERATIONS = 100_000; // matches `openssl enc -iter 100000`
const KEY_BYTES = 32;
const IV_BYTES = 16;
const SALT_BYTES = 8;

export interface WrapBundleArgs {
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly backupId: string;
  /** Plaintext passphrase. Caller MUST NOT log it. */
  readonly passphrase: string;
  /** All component artifacts to bundle into the tarball. */
  readonly components: ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>;
}

export interface WrapBundleResult {
  readonly artifactPath: string;
  readonly sizeBytes: number;
}

/**
 * Build a single AES-256-CBC encrypted tar.gz of the bundle dir +
 * meta.json, write it to the BackupStore as
 * `components/export/<backupId>.tar.gz.enc`. Stream-only — no
 * intermediate disk + no whole-file buffering.
 */
export async function wrapBundleAsDataExport(args: WrapBundleArgs): Promise<WrapBundleResult> {
  const { store, handle, backupId, passphrase, components } = args;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('wrapBundleAsDataExport: passphrase must be ≥12 chars');
  }

  // Derive AES key + IV from passphrase + random salt via PBKDF2.
  // Same KDF and parameters as `openssl enc -pbkdf2 -iter 100000`.
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  // Build a tar stream in memory: meta.json + every component artifact.
  // Backed by a Readable so we can pipe through gzip + cipher without
  // materialising the whole bundle in RAM.
  const tar = tarPack();

  // Add meta.json first.
  const meta = await store.getMeta(handle);
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
  tar.entry({ name: 'meta.json', size: metaBuf.length, mtime: new Date(meta.capturedAt) }, metaBuf);

  // Stream each component artifact into the tar. Drives the tar via
  // an awaitable wrapper so back-pressure works.
  // Run in parallel with the encryption pipeline below.
  const tarFeeder = (async () => {
    try {
      for (const c of components) {
        const stat = await store.stat(handle, c.component, c.name);
        if (!stat) continue; // missing artifact (component was skipped)
        const body = await store.readComponent(handle, c.component, c.name);
        const entry = tar.entry({
          name: `components/${c.component}/${c.name}`,
          size: stat.sizeBytes,
          mtime: new Date(),
        });
        await pipeline(body, entry);
      }
      tar.finalize();
    } catch (err) {
      tar.destroy(err as Error);
    }
  })();

  // Cipher: AES-256-CBC. PKCS#7 padding (Node's default).
  const cipher = createCipheriv('aes-256-cbc', key, iv);

  // Build the output: "Salted__" magic + salt + ciphertext, where
  // ciphertext = AES-CBC(gzip(tar)). Prepend the OpenSSL header
  // bytes via a one-shot Transform that emits them before piping
  // the cipher output.
  const header = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt]);
  let headerEmitted = false;
  const headerPrepender = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerEmitted) {
        this.push(header);
        headerEmitted = true;
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!headerEmitted) {
        this.push(header);
        headerEmitted = true;
      }
      cb();
    },
  });

  // tar -> gzip -> cipher -> headerPrepender -> store.writeComponent
  const gzip = createGzip({ level: 6 });
  // BackupComponentName is constrained to files/mailboxes/config/
  // secrets in the storage layer. The export artifact is written
  // under the 'config' component slot but with a distinctive name
  // `data-export-<backupId>.tar.gz.enc` so it can never collide
  // with the legitimate `db-rows.json.gz` artifact in the same
  // component dir. A Phase-4.x follow-up could promote 'export'
  // to a first-class component name; for now this naming
  // convention is the gate the download endpoint validates against.
  const artifactName = `data-export-${backupId}.tar.gz.enc`;
  const synthComponent = 'config' as const;

  const inputStream = (tar as unknown as Readable).pipe(gzip).pipe(cipher).pipe(headerPrepender);
  const ref = await store.writeComponent(handle, synthComponent, artifactName, inputStream as Readable, {
    contentType: 'application/octet-stream',
  });
  await tarFeeder; // surface tar errors

  return {
    artifactPath: `components/${synthComponent}/${artifactName}`,
    sizeBytes: ref.sizeBytes,
  };
}

// ─── Multi-region export / import ─────────────────────────────────
//
// The wrapper above WRITES the encrypted tarball back to the same
// off-site target (used by the create-time `exportMode: 'data_export'`
// flow). For multi-region export we want a different shape:
//
//   - Operator picks ANY existing bundle and clicks "Export".
//   - Backend produces the same Salted__-envelope tarball but
//     STREAMS it directly to the HTTP reply — no store.write.
//   - Operator downloads, copies to another region, and uploads
//     via the import endpoint.
//
// `streamEncryptedExport` is the shared inner stream builder.
// `decryptImportTarball` is the inverse used by the import endpoint.

export interface StreamExportArgs {
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly passphrase: string;
  readonly components: ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>;
}

/**
 * Build a Readable that yields the OpenSSL Salted__-envelope of
 * gzip(tar(meta.json + every component artifact)) encrypted with
 * AES-256-CBC under a key derived from `passphrase`. Same wire
 * format as `wrapBundleAsDataExport`. Caller pipes the returned
 * stream to the HTTP reply.
 */
export function streamEncryptedExport(args: StreamExportArgs): Readable {
  const { store, handle, passphrase, components } = args;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('streamEncryptedExport: passphrase must be ≥12 chars');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  const tar = tarPack();

  // Async feeder: meta.json + every component artifact in turn.
  // tar-stream backpressures naturally via the entry stream.
  (async () => {
    try {
      const meta = await store.getMeta(handle);
      const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
      tar.entry({ name: 'meta.json', size: metaBuf.length, mtime: new Date(meta.capturedAt) }, metaBuf);

      for (const c of components) {
        const stat = await store.stat(handle, c.component, c.name);
        if (!stat) continue;
        const body = await store.readComponent(handle, c.component, c.name);
        const entry = tar.entry({
          name: `components/${c.component}/${c.name}`,
          size: stat.sizeBytes,
          mtime: new Date(),
        });
        await pipeline(body, entry);
      }
      tar.finalize();
    } catch (err) {
      tar.destroy(err as Error);
    }
  })();

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const header = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt]);
  let headerEmitted = false;
  const headerPrepender = new Transform({
    transform(chunk, _enc, cb) {
      if (!headerEmitted) { this.push(header); headerEmitted = true; }
      cb(null, chunk);
    },
    flush(cb) {
      if (!headerEmitted) { this.push(header); headerEmitted = true; }
      cb();
    },
  });

  const gzip = createGzip({ level: 6 });
  return (tar as unknown as Readable).pipe(gzip).pipe(cipher).pipe(headerPrepender);
}

export interface ImportEntry {
  /** `meta.json` or `components/<component>/<name>`. */
  readonly path: string;
  readonly buffer: Buffer;
}

/**
 * Inverse of `streamEncryptedExport`: takes a buffered Salted__-
 * envelope tarball + passphrase, returns each tar entry as
 * (path, buffer). The caller then registers a new bundle row +
 * uploads each entry to the local off-site target.
 *
 * Buffered (not streaming) on purpose:
 *   - Bundles are typically <1 GB and the HTTP request body is
 *     already buffered into memory by Fastify multipart.
 *   - The import flow needs to write each artifact to a different
 *     `store.writeComponent` call, which is awkward to interleave
 *     with the inner tar-extract stream. Buffering each entry first
 *     keeps the import code linear.
 */
export async function decryptImportTarball(args: {
  readonly cipherBlob: Buffer;
  readonly passphrase: string;
}): Promise<ReadonlyArray<ImportEntry>> {
  const { cipherBlob, passphrase } = args;
  if (!passphrase || passphrase.length < 12) {
    throw new Error('decryptImportTarball: passphrase must be ≥12 chars');
  }

  // Parse OpenSSL Salted__ header.
  if (cipherBlob.length < 16 || cipherBlob.subarray(0, 8).toString('ascii') !== 'Salted__') {
    throw new Error('decryptImportTarball: not an OpenSSL Salted__ envelope');
  }
  const salt = cipherBlob.subarray(8, 16);
  const ciphertext = cipherBlob.subarray(16);

  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const key = derived.subarray(0, KEY_BYTES);
  const iv = derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES);

  // Decrypt → gunzip → tar extract → buffer each entry.
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const gunzip = createGunzip();
  const tarX = tarExtract();

  // Silence "unhandled 'error' event" noise: the pipeline below
  // already captures + rethrows any failure. We just need each
  // stream to have an error listener so Node doesn't escalate.
  // (The Promise<void> below ALSO attaches a tarX.on('error',…)
  // — both listeners fire; that's fine.)
  decipher.on('error', () => undefined);
  gunzip.on('error', () => undefined);

  const entries: ImportEntry[] = [];
  const collect = new Promise<void>((resolve, reject) => {
    tarX.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        entries.push({ path: header.name, buffer: Buffer.concat(chunks) });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    tarX.on('finish', () => resolve());
    tarX.on('error', reject);
  });

  // Drive the pipeline. Wrong passphrase manifests as a decipher
  // error ("bad decrypt") OR garbage bytes that gunzip rejects.
  // Both surface as the rejection of `pipeline`. We swallow the
  // 'error' event bubble by attaching no-op listeners above so
  // Node doesn't escalate; the final user-facing message comes
  // from the rethrow here.
  try {
    await pipeline(Readable.from(ciphertext), decipher, gunzip, tarX);
    await collect;
  } catch (err) {
    throw new Error(`import-decrypt failed (wrong passphrase or corrupt blob): ${err instanceof Error ? err.message : String(err)}`);
  }
  return entries;
}
