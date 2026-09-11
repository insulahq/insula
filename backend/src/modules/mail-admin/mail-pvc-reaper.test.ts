/**
 * Mail-store reaper guards.
 *
 * This script issues `rm -rf` against the node holding the mail store, so the
 * tests that matter are the ones proving what it will NOT delete. The
 * behaviour was additionally verified end-to-end on a real node against a
 * synthetic tree: the live directory survived even when backdated five days,
 * a fresh orphan was kept, a five-day-old orphan was reaped, and a
 * non-matching directory was untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReaperScript,
  resolveLiveMailPvcLocation,
  ORPHAN_GRACE_HOURS,
  MAIL_PVC_DIR_GLOB,
} from './mail-pvc-reaper.js';

describe('buildReaperScript', () => {
  const script = buildReaperScript('pvc-abc_mail_mail-stack-data', ORPHAN_GRACE_HOURS);

  it('is valid shell — newline separated, never "do;" or "then;"', () => {
    // Joining the lines with '; ' produced `for … do;` and `if … then;`,
    // which are syntax errors: the Job would have failed on every node.
    expect(script).not.toMatch(/\bdo;/);
    expect(script).not.toMatch(/\bthen;/);
    expect(script.split('\n').length).toBeGreaterThan(5);
  });

  it('refuses to run when the live directory is unknown', () => {
    const blind = buildReaperScript('', ORPHAN_GRACE_HOURS);
    expect(blind).toContain('refusing to reap');
    expect(blind).toContain('exit 1');
  });

  it('skips the live directory by exact name', () => {
    expect(script).toContain('pvc-abc_mail_mail-stack-data');
    expect(script).toContain('"$d" = "$LIVE_DIR"');
    expect(script).toContain('keep (LIVE)');
  });

  it('only deletes past the grace window, expressed in minutes', () => {
    expect(script).toContain(`-mmin +${ORPHAN_GRACE_HOURS * 60}`);
  });

  it('scopes the glob to the mail stack, so nothing else can match', () => {
    expect(script).toContain(MAIL_PVC_DIR_GLOB);
    expect(MAIL_PVC_DIR_GLOB).toBe('*_mail_mail-stack-data');
  });

  it('deletes only inside the hostPath mount', () => {
    expect(script).toContain('cd /host/storage');
    // Relative `rm -rf "$d"` after the cd — never an absolute path that
    // could escape the mount.
    expect(script).toContain('rm -rf "$d"');
    expect(script).not.toMatch(/rm -rf \//);
  });
});

describe('resolveLiveMailPvcLocation', () => {
  const k8sWith = (pvc: unknown, pv: unknown) => ({
    core: {
      readNamespacedPersistentVolumeClaim: async () => pvc,
      readPersistentVolume: async () => pv,
    },
  } as unknown as Parameters<typeof resolveLiveMailPvcLocation>[0]);

  it('resolves the node and directory from the bound PV', async () => {
    const loc = await resolveLiveMailPvcLocation(k8sWith(
      { spec: { volumeName: 'pvc-abc' } },
      {
        spec: {
          local: { path: '/var/lib/rancher/k3s/storage/pvc-abc_mail_mail-stack-data' },
          nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ values: ['node-a'] }] }] } },
        },
      },
    ));
    expect(loc).toEqual({
      nodeName: 'node-a',
      path: '/var/lib/rancher/k3s/storage/pvc-abc_mail_mail-stack-data',
      dirName: 'pvc-abc_mail_mail-stack-data',
    });
  });

  it('returns null on an unbound PVC rather than guessing', async () => {
    expect(await resolveLiveMailPvcLocation(k8sWith({ spec: {} }, {}))).toBeNull();
  });

  it('returns null when the PV has no node affinity — cannot prove what is live', async () => {
    const loc = await resolveLiveMailPvcLocation(k8sWith(
      { spec: { volumeName: 'pvc-abc' } },
      { spec: { local: { path: '/var/lib/rancher/k3s/storage/pvc-abc_mail_mail-stack-data' } } },
    ));
    expect(loc).toBeNull();
  });
});
