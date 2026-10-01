import { describe, it, expect } from 'vitest';
import { createGzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pack as tarPack } from 'tar-stream';

import { readArchiveMeta, ArchiveMetaError, MAX_SCAN_BYTES } from './import-archive-meta.js';
import { PBKDF2_ITERATIONS, KEY_BYTES, IV_BYTES, SALT_BYTES } from './data-export.js';

const META = { bundleId: 'bkp-1', tenantId: 't-1', components: { files: { sizeBytes: 10 } } };

/** Build a real tar.gz whose first entry is meta.json, plus optional filler. */
async function plainArchive(
  // `null` means "omit meta.json". NOT `undefined` — that triggers the default
  // parameter, so `plainArchive(undefined, …)` silently still writes META and
  // the no-meta test passed a perfectly valid archive.
  meta: unknown = META,
  extra: ReadonlyArray<{ name: string; size: number }> = [],
): Promise<Buffer> {
  const tar = tarPack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res) => gzip.on('end', () => res()));
  (tar as unknown as NodeJS.ReadableStream).pipe(gzip);

  if (meta !== null) {
    const buf = Buffer.from(typeof meta === 'string' ? meta : JSON.stringify(meta), 'utf8');
    tar.entry({ name: 'meta.json', size: buf.length }, buf);
  }
  for (const e of extra) {
    // RANDOM filler, not a repeated byte: gzip crushes 24 MiB of 'a' to ~24 KB,
    // so a compressible filler would make the "stops early" assertion vacuous —
    // the reader would look frugal only because the archive was tiny.
    tar.entry({ name: e.name, size: e.size }, randomBytes(e.size));
  }
  tar.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Wrap a plaintext tar.gz in the OpenSSL `Salted__` envelope the export uses. */
function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_BYTES + IV_BYTES, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, KEY_BYTES), derived.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES));
  return Buffer.concat([Buffer.from('Salted__', 'ascii'), salt, cipher.update(plain), cipher.final()]);
}

/** A Readable that reports how many bytes were actually pulled out of it. */
function countingStream(buf: Buffer, chunkSize = 64 * 1024): { stream: Readable; pulled: () => number } {
  let pulled = 0;
  let offset = 0;
  const stream = new Readable({
    read() {
      if (offset >= buf.length) { this.push(null); return; }
      const end = Math.min(offset + chunkSize, buf.length);
      const slice = buf.subarray(offset, end);
      offset = end;
      pulled += slice.length;
      this.push(slice);
    },
  });
  return { stream, pulled: () => pulled };
}

describe('readArchiveMeta — plaintext tar.gz', () => {
  it('reads meta.json', async () => {
    const r = await readArchiveMeta({ stream: Readable.from(await plainArchive()) });
    expect(r.format).toBe('tar-plain');
    expect(r.meta).toMatchObject({ bundleId: 'bkp-1', tenantId: 't-1' });
  });

  it('★ stops after meta.json instead of draining the archive', async () => {
    // The whole point of streaming: a 25 GB upload must cost the first few KB.
    // 24 MiB of filler after meta.json, read in 64 KiB chunks — if the reader
    // drained it, `pulled` would be the full length.
    const archive = await plainArchive(META, [{ name: 'components/files/archive', size: 24 * 1024 * 1024 }]);
    expect(archive.length).toBeGreaterThan(1_000_000);
    const { stream, pulled } = countingStream(archive);
    const r = await readArchiveMeta({ stream });
    expect(r.meta).toMatchObject({ bundleId: 'bkp-1' });
    // Generous ceiling — the assertion is "a small constant", not the exact
    // number, which depends on gzip framing and the peek size.
    expect(pulled()).toBeLessThan(2 * 1024 * 1024);
    expect(pulled()).toBeLessThan(archive.length);
  });

  it('rejects an archive with no meta.json', async () => {
    const archive = await plainArchive(null, [{ name: 'components/config/x', size: 16 }]);
    await expect(readArchiveMeta({ stream: Readable.from(archive) }))
      .rejects.toMatchObject({ code: 'META_NOT_FOUND' });
  });

  it('rejects meta.json that is not valid JSON', async () => {
    await expect(readArchiveMeta({ stream: Readable.from(await plainArchive('{not json')) }))
      .rejects.toMatchObject({ code: 'META_INVALID_JSON' });
  });

  it('rejects meta.json that is JSON but not an object', async () => {
    // `[1,2,3]` parses. A downstream `meta.components` read would then be
    // undefined and the import would silently carry nothing.
    await expect(readArchiveMeta({ stream: Readable.from(await plainArchive('[1,2,3]')) }))
      .rejects.toMatchObject({ code: 'META_INVALID_JSON' });
  });

  it('rejects an empty stream', async () => {
    await expect(readArchiveMeta({ stream: Readable.from(Buffer.alloc(0)) }))
      .rejects.toMatchObject({ code: 'ARCHIVE_EMPTY' });
  });

  it('rejects bytes that are not an archive at all', async () => {
    await expect(readArchiveMeta({ stream: Readable.from(Buffer.from('hello world, not an archive')) }))
      .rejects.toBeInstanceOf(ArchiveMetaError);
  });

  it('rejects a gzip that is not a tar', async () => {
    await expect(readArchiveMeta({ stream: Readable.from(gzipSync(Buffer.from('just text'))) }))
      .rejects.toBeInstanceOf(Error);
  });
});

describe('readArchiveMeta — encrypted tar.gz.enc', () => {
  it('reads meta.json with the right passphrase', async () => {
    const enc = encrypt(await plainArchive(), 'correct horse battery');
    const r = await readArchiveMeta({ stream: Readable.from(enc), passphrase: 'correct horse battery' });
    expect(r.format).toBe('tar-encrypted');
    expect(r.meta).toMatchObject({ bundleId: 'bkp-1' });
  });

  it('says the passphrase is wrong rather than leaking a zlib error', async () => {
    // AES-CBC happily decrypts to noise; gunzip then fails with "incorrect
    // header check", which tells an operator nothing about what to do.
    const enc = encrypt(await plainArchive(), 'right');
    await expect(readArchiveMeta({ stream: Readable.from(enc), passphrase: 'wrong' }))
      .rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' });
  });

  it('asks for a passphrase rather than failing obscurely when none is given', async () => {
    const enc = encrypt(await plainArchive(), 'right');
    await expect(readArchiveMeta({ stream: Readable.from(enc) }))
      .rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
  });

  it('rejects an archive truncated inside its encryption header', async () => {
    const enc = encrypt(await plainArchive(), 'right').subarray(0, 10);
    await expect(readArchiveMeta({ stream: Readable.from(enc), passphrase: 'right' }))
      .rejects.toMatchObject({ code: 'ARCHIVE_TRUNCATED' });
  });
});

describe('readArchiveMeta — ZIP', () => {
  it('refuses ZIP with an actionable message instead of a parse error', async () => {
    // PK\x03\x04 — a zip's index lives at the END, so "read the head" is not
    // something a zip can do. Both panels download tar by default.
    const zipish = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(120)]);
    await expect(readArchiveMeta({ stream: Readable.from(zipish) }))
      .rejects.toMatchObject({ code: 'ARCHIVE_FORMAT_UNSUPPORTED' });
  });
});

describe('scan cap', () => {
  it('is large enough for a real meta but far below a bundle', () => {
    expect(MAX_SCAN_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_SCAN_BYTES).toBeLessThan(1024 * 1024 * 1024);
  });
});
