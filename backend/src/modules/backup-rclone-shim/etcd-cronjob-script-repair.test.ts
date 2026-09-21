/**
 * The upload script must not write empty checksums.
 *
 * Production: every etcd snapshot in off-site storage (24 of 24)
 * carried `"sha256":""` in its sidecar, so none of them could be verified
 * before a restore. Reproduced on DEV — the job's own stderr said:
 *
 *     sha256sum: can't open '1name': No such file or directory
 *     /bin/sh: can't open 1TMP: no such file
 *
 * `1` is the shell's PID. The CronJob ships `reconcile: disabled`, so Flux
 * SKIPS it and never collapses the `$$` escaping written for Flux; the kubelet
 * does collapse `$$`, but it leaves `$( ... )` spans verbatim because it cannot
 * resolve them as variable references. Inside a substitution the shell
 * therefore sees `$$` and expands it to its own PID.
 *
 * Fixing the manifest alone would reach FRESH installs only — a disowned
 * CronJob never re-reads it — so the reconciler repairs the live script.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findScriptRepair } from './etcd-cronjob.js';

/** The exact script shipped to production, trimmed to the two broken lines. */
const BROKEN_SCRIPT = [
  'set -eu',
  'SRC=/snapshots',
  'cd "$$SRC"',
  'TMP=/tmp/etcd-files',
  'find . -maxdepth 1 -type f -mmin -75 2>/dev/null | sed \'s|^\\./||\' > "$$TMP" || true',
  `COUNT=$(wc -l < "$$TMP" | tr -d ' ')`,
  'while IFS= read -r name; do',
  '  DEST="$$HOST-$$TS-$$name.db"',
  '  rclone $$CFG_FLAGS copyto "$$name" ":s3:$$SHIM_BUCKET/$$SHIM_PREFIX/$$DEST"',
  `  SHA=$(sha256sum "$$name" | cut -d ' ' -f 1)`,
  '  META="{\\"timestamp\\":\\"$$TS\\",\\"sha256\\":\\"$$SHA\\"}"',
  'done < "$$TMP"',
].join('\n');

const liveWith = (script: string) => ({
  spec: {
    jobTemplate: {
      spec: { template: { spec: { containers: [{ args: ['-c', script] }] } } },
    },
  },
});

describe('findScriptRepair', () => {
  it('repairs both lines that evaluated to the shell PID', () => {
    const repair = findScriptRepair(liveWith(BROKEN_SCRIPT));
    expect(repair).not.toBeNull();
    // args[1] — the script is the second element, after `-c`.
    expect(repair?.path).toBe('/spec/jobTemplate/spec/template/spec/containers/0/args/1');

    const fixed = repair!.value;
    // No `$$` may survive INSIDE a command substitution any more.
    for (const span of fixed.match(/\$\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
      expect(span, `"${span}" still carries $$ inside $( )`).not.toMatch(/\$\$[A-Za-z_{]/);
    }
    // The values are bound outside the substitution instead.
    expect(fixed).toContain('f="$$name"');
    expect(fixed).toContain('t="$$TMP"');
  });

  it('leaves the rest of the script untouched', () => {
    // The repair must be surgical: `$$` OUTSIDE a substitution is correct as it
    // stands — the kubelet collapses it — and rewriting those would break a
    // working upload path.
    const fixed = findScriptRepair(liveWith(BROKEN_SCRIPT))!.value;
    expect(fixed).toContain('rclone $$CFG_FLAGS copyto "$$name"');
    expect(fixed).toContain('DEST="$$HOST-$$TS-$$name.db"');
    expect(fixed).toContain('done < "$$TMP"');
  });

  it('returns null once the script is already repaired (idempotent)', () => {
    // The reconciler runs continuously; a repair that never converges would
    // PATCH the CronJob on every single tick.
    const fixed = findScriptRepair(liveWith(BROKEN_SCRIPT))!.value;
    expect(findScriptRepair(liveWith(fixed))).toBeNull();
  });

  it('returns null for a fresh install that seeded the corrected manifest', () => {
    const good = [
      'set -eu',
      `t="$$TMP"; COUNT=$(wc -l < "$t" | tr -d ' ')`,
      `f="$$name"; SHA=$(sha256sum "$f" | cut -d ' ' -f 1)`,
    ].join('\n');
    expect(findScriptRepair(liveWith(good))).toBeNull();
  });

  it('returns null when the container has no args at all', () => {
    expect(findScriptRepair({ spec: { jobTemplate: { spec: { template: { spec: { containers: [{}] } } } } } })).toBeNull();
    expect(findScriptRepair({})).toBeNull();
  });
});

/**
 * Retention: the eviction count was the literal `25`, so the operator's
 * "keep last N" had nothing to act on. The repair swaps that one pipeline
 * stage for the env-driven awk the manifest now ships.
 *
 * The important property is not that SOME replacement happens — it is that a
 * repaired cluster and a fresh install end up running the SAME line. So this
 * reads the expectation out of the manifest rather than restating it, which
 * would let the two drift apart while both tests stayed green.
 */
describe('retention count repair', () => {
  const MANIFEST = fileURLToPath(new URL(
    '../../../../k8s/base/backup/etcd-snap-via-shim-cronjob.yaml', import.meta.url,
  ));

  /** The eviction stage as the manifest ships it, with Flux's `$$` collapsed. */
  function manifestEvictionStage(): string {
    const yaml = readFileSync(MANIFEST, 'utf8');
    const line = yaml.split('\n').find((l) => l.includes('awk -v keep='));
    expect(line, 'manifest no longer contains an awk eviction stage').toBeTruthy();
    // `$$` is Flux escaping; the kubelet collapses it before the shell runs.
    return line!.trim().replace(/\$\$/g, '$').replace(/^\|\s*/, '').replace(/\s*>.*$/, '');
  }

  it('replaces the hardcoded 25 with the env-driven stage', () => {
    const live = {
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{
        args: ['set -eu\nrclone lsf | sort -r | tail -n +25 > "$TMP_EV" || true\n'],
      }] } } } } },
    };
    const repair = findScriptRepair(live as never);
    expect(repair).not.toBeNull();
    expect(repair!.value).not.toContain('tail -n +25');
    expect(repair!.value).toContain('RETENTION_COUNT');
  });

  it('produces exactly the stage the manifest ships (no drift)', () => {
    const live = {
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{
        args: ['sort -r | tail -n +25 > "$TMP_EV"'],
      }] } } } } },
    };
    const repair = findScriptRepair(live as never);
    expect(repair!.value).toContain(manifestEvictionStage());
  });

  it('leaves an already-repaired script alone', () => {
    const live = {
      spec: { jobTemplate: { spec: { template: { spec: { containers: [{
        args: [`sort -r | ${manifestEvictionStage()} > "$TMP_EV"`],
      }] } } } } },
    };
    expect(findScriptRepair(live as never)).toBeNull();
  });
});
