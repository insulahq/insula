/**
 * The upload script must not write empty checksums.
 *
 * Production, 2026-09-18: every etcd snapshot in off-site storage (24 of 24)
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
