/**
 * End-to-end proof of the tenant-bundle reclamation path (ADR-048), run
 * against a REAL local restic repository using the platform's own driver
 * functions — not a mock.
 *
 * It answers the question that motivated the work: if the oldest snapshot is
 * deleted while later snapshots are deduplicated against it, do the survivors
 * still restore? Restic has no "base backup" — every snapshot is a complete
 * tree and `prune` only drops blobs no remaining snapshot references — but
 * that is a claim about restic, and this asserts it on real data, including
 * after a repack.
 *
 * Usage:  node_modules/.bin/tsx scripts/integration-restic-reclaim.ts
 * Requires: the `restic` binary on PATH. No cluster, no network.
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import {
  runResticBackup,
  runResticForget,
  runResticPrune,
  runResticRestore,
  runResticStats,
  listResticSnapshots,
  ensureResticRepoInitialised,
  buildResticRepoUri,
  deriveResticPassword,
  type BackupTarget,
} from '../backend/src/modules/tenant-bundles/restic-driver.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT = 'reclaim-fixture-tenant';

let failures = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'restic-reclaim-'));
  const repoDir = join(root, 'store');
  await mkdir(repoDir, { recursive: true });
  const target: BackupTarget = { kind: 'hostpath', hostPath: repoDir };
  const passwordHex = deriveResticPassword(KEY, TENANT);
  const repoUri = buildResticRepoUri(target, TENANT, 'files');

  try {
    console.log(`repo: ${repoUri}`);
    await ensureResticRepoInitialised({ target, passwordHex, repoUri });

    // Three snapshots with heavily overlapping content, so later ones
    // genuinely deduplicate against the first — the scenario in question.
    // Deterministic pseudo-random shared prefix. Uniform bytes (e.g.
    // 'S'.repeat(N)) defeat restic's content-defined chunker — it finds no
    // cut points and stores one giant unique chunk per snapshot, so nothing
    // deduplicates and the fixture would prove the opposite of the point.
    const prng = (n: number): Buffer => {
      const b = Buffer.allocUnsafe(n);
      let x = 0x2545f491;
      for (let i = 0; i < n; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
        b[i] = x & 0xff;
      }
      return b;
    };
    const shared = prng(3 * 1024 * 1024).toString('latin1');
    const payloads = [
      `${shared}__ONE__`,
      `${shared}__TWO__`,
      `${shared}__THREE__`,
    ];
    const snapIds: string[] = [];
    for (let i = 0; i < payloads.length; i++) {
      const res = await runResticBackup({
        target, tenantId: TENANT, component: 'files', passwordHex,
        stdinFilename: 'payload.bin',
        tags: [`bundle-id=bundle-${i + 1}`, 'component=files'],
        stdin: Readable.from([Buffer.from(payloads[i]!, 'latin1')]),
      });
      snapIds.push(res.snapshotId);
      console.log(`  snapshot ${i + 1}: ${res.snapshotId.slice(0, 12)}  (${res.totalBytesProcessed} bytes processed)`);
    }

    const dedupWorked = await (async () => {
      const st = await runResticStats({ target, passwordHex, repoUri });
      // 3 x 3 MiB of near-identical data must not occupy ~9 MiB.
      console.log(`  repo raw-data after 3 snapshots: ${st.totalSizeBytes} bytes`);
      return st.totalSizeBytes < 3 * 3 * 1024 * 1024 * 0.7;
    })();
    ok('later snapshots deduplicate against the first', dedupWorked);

    // runResticRestore builds the repo URI from the target itself, so give it
    // a target already pointed at this component repo.
    const restoreTarget: BackupTarget = { kind: 'hostpath', hostPath: repoUri };
    const restoreOf = async (snapshotId: string): Promise<string> => {
      const dir = await mkdtemp(join(root, 'restore-'));
      await runResticRestore({ target: restoreTarget, passwordHex, snapshotId, targetDir: dir, readOnly: false });
      return readFile(join(dir, 'payload.bin'), 'latin1');
    };

    ok('snapshot 3 restores byte-identical before any forget',
      (await restoreOf(snapIds[2]!)) === payloads[2]);

    // ── The question: forget the OLDEST snapshot ────────────────────────────
    await runResticForget({ target, passwordHex, repoUri, snapshotIds: [snapIds[0]!] });
    const afterForget = await listResticSnapshots({ target, passwordHex, readOnly: true, repoUri });
    const idsAfter = afterForget.map((s) => s.id);
    ok('forgotten snapshot is gone from the list', !idsAfter.includes(snapIds[0]!));
    ok('the two later snapshots survive the forget',
      idsAfter.includes(snapIds[1]!) && idsAfter.includes(snapIds[2]!),
      `list=${idsAfter.map((i) => i.slice(0, 8)).join(',')}`);
    ok('snapshot 2 still restores byte-identical after the oldest was forgotten',
      (await restoreOf(snapIds[1]!)) === payloads[1]);
    ok('snapshot 3 still restores byte-identical after the oldest was forgotten',
      (await restoreOf(snapIds[2]!)) === payloads[2]);

    // ── Prune: the step that actually rewrites packs ────────────────────────
    // Measure BYTES ON DISK, not `stats --mode raw-data`. raw-data counts the
    // blobs still REFERENCED by snapshots, so it drops the moment a snapshot
    // is forgotten even though the packs are untouched — using it here would
    // "prove" reclamation that had not happened. Only prune frees disk.
    const diskBytes = (): number =>
      Number(execFileSync('du', ['-sb', repoDir], { encoding: 'utf8' }).split(/\s+/)[0]);

    const referencedBefore = (await runResticStats({ target, passwordHex, repoUri })).totalSizeBytes;
    const diskBefore = diskBytes();
    await runResticPrune({ target, passwordHex, repoUri });
    const diskAfter = diskBytes();
    console.log(`  referenced (raw-data): ${referencedBefore}`);
    console.log(`  on disk before prune: ${diskBefore}, after: ${diskAfter}`);
    ok('prune reclaims real disk space', diskAfter < diskBefore,
      `${diskBefore} -> ${diskAfter}`);
    ok('the forgotten snapshot\'s unreferenced data is actually gone from disk',
      diskAfter < referencedBefore * 1.5,
      `disk=${diskAfter} referenced=${referencedBefore}`);
    ok('snapshot 2 STILL restores byte-identical after prune repacked the repo',
      (await restoreOf(snapIds[1]!)) === payloads[1]);
    ok('snapshot 3 STILL restores byte-identical after prune repacked the repo',
      (await restoreOf(snapIds[2]!)) === payloads[2]);

    // restic's own integrity check is the strongest statement available.
    const check = execFileSync('restic', ['--repo', repoUri, 'check', '--read-data'], {
      env: { PATH: process.env.PATH ?? '', RESTIC_PASSWORD: passwordHex },
      encoding: 'utf8',
    });
    ok('restic check --read-data reports no errors', /no errors were found/i.test(check),
      check.trim().split('\n').slice(-1)[0]);

    // ── Guards ─────────────────────────────────────────────────────────────
    let rejected = false;
    try {
      await runResticForget({ target, passwordHex, repoUri, snapshotIds: ['--repo=/etc/passwd'] });
    } catch { rejected = true; }
    ok('a malformed snapshot id is rejected before reaching argv', rejected);

    const stillThere = await listResticSnapshots({ target, passwordHex, readOnly: true, repoUri });
    ok('the repo is unchanged by the rejected call', stillThere.length === 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
