/**
 * A corrupt archive must not leave an orphaned promise rejection behind.
 *
 * Both extract paths build a `collect` promise that rejects when the tar
 * stream errors, then `await pipeline(...)` followed by `await collect`. When
 * the pipeline itself fails — a corrupt gzip header is the usual cause —
 * `pipeline` destroys the tar stream with that same error, so `collect`
 * rejects too; but control has already jumped to the catch, so `await collect`
 * is never reached and that rejection has no handler.
 *
 * In the API process that reaches the process-level `unhandledRejection`
 * handler, from nothing worse than a user uploading a damaged bundle.
 *
 * CI hit this on 2026-09-17 as "Error: incorrect header check" attributed to
 * a test file that merely happened to be running at the time — every test
 * passed and the run still failed. It reproduces only when the wrong-passphrase
 * decrypt lands on a valid pad length (~1 in 256), which is why it stayed
 * hidden. The two tests below trigger the same path deterministically.
 */
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

/** Collect unhandled rejections fired while `fn` runs, plus a few turns after. */
async function unhandledDuring(fn: () => Promise<void>): Promise<readonly string[]> {
  const seen: string[] = [];
  const onUnhandled = (r: unknown) => seen.push(r instanceof Error ? r.message : String(r));
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // Node fires unhandledRejection on a later turn, so give it several.
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('a corrupt archive leaves no orphaned rejection', () => {
  it('plain tar.gz path: a bad gzip header is reported, and only once', async () => {
    const { extractImportArchive } = await import('./data-export.js');
    // Real gzip magic so the format detector picks tar-plain, garbage after it
    // so the gunzip stream errors mid-pipeline.
    const magic = gzipSync(Buffer.alloc(64)).subarray(0, 3);
    const blob = Buffer.concat([magic, Buffer.from('garbage'.repeat(20))]);

    let message = '';
    const orphans = await unhandledDuring(async () => {
      await expect(extractImportArchive({ blob }).then(
        () => { throw new Error('expected the corrupt archive to be refused'); },
        (err: Error) => { message = err.message; },
      )).resolves.toBeUndefined();
    });

    // The caller still learns what happened — the fix marks the second
    // rejection handled, it does not silence the first.
    expect(message).toMatch(/corrupt tar\.gz/);
    expect(orphans).toEqual([]);
  });

  it('encrypted path: a decryptable but non-gzip payload is reported, and only once', async () => {
    const { decryptImportTarball } = await import('./data-export.js');
    // Build a valid Salted__ envelope around bytes that are NOT gzip. The
    // decrypt succeeds, so the failure lands exactly where the ~1-in-256
    // wrong-passphrase case lands it: in the gunzip.
    const passphrase = 'right-passphrase-12345';
    const salt = randomBytes(8);
    const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 48, 'sha256');
    const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
    const body = Buffer.concat([cipher.update(Buffer.from('not gzip at all')), cipher.final()]);
    const cipherBlob = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, body]);

    let message = '';
    const orphans = await unhandledDuring(async () => {
      await decryptImportTarball({ cipherBlob, passphrase }).then(
        () => { throw new Error('expected the corrupt tarball to be refused'); },
        (err: Error) => { message = err.message; },
      );
    });

    expect(message).toMatch(/import-extract failed/);
    expect(orphans).toEqual([]);
  });
});
