/**
 * Final sync for a PLANNED mail move (source alive): after Stalwart stops on
 * the source, copy the now-quiet volume into the target's standby copy, so the
 * target restores the CURRENT mail instead of the ≤5-minute-old copy the
 * replicate DaemonSet last made. VM drill: a message written a minute before a
 * failback was gone after it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  FINAL_SYNC_PUBLISHER_APP,
  FINAL_SYNC_PULLER_APP,
  rsyncUrlFor,
  runFinalStandbySync,
} from './final-sync.js';

type Pod = { metadata: { name: string; labels?: Record<string, string> }; spec: Record<string, unknown> };

function harness(opts: {
  publisherReady?: boolean;
  podIP?: string;
  pullerPhase?: 'Succeeded' | 'Failed' | 'Running';
  pullerLog?: string;
  missingDaemonSet?: boolean;
} = {}) {
  const created: Pod[] = [];
  const deleted: string[] = [];
  const core = {
    createNamespacedPod: vi.fn(async ({ body }: { body: Pod }) => { created.push(body); return body; }),
    readNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      if (name.includes('-pub-')) {
        return {
          status: {
            phase: 'Running',
            podIP: opts.podIP ?? '10.42.1.7',
            conditions: [{ type: 'Ready', status: opts.publisherReady === false ? 'False' : 'True' }],
          },
        };
      }
      return { status: { phase: opts.pullerPhase ?? 'Succeeded' } };
    }),
    deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => { deleted.push(name); }),
    readNamespacedPodLog: vi.fn(async () => opts.pullerLog ?? ''),
  };
  const apps = {
    readNamespacedDeployment: vi.fn(async () => ({
      spec: { template: { spec: { containers: [
        { name: 'stalwart', image: 'stalwart:x' },
        { name: 'rsyncd', image: 'rsync-img:1' },
      ] } } },
    })),
    readNamespacedDaemonSet: vi.fn(async () => {
      if (opts.missingDaemonSet) throw Object.assign(new Error('nf'), { code: 404 });
      return { spec: { template: { spec: { containers: [{ name: 'replicate', image: 'tools-img:2' }] } } } };
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  // A fake clock: every sleep advances it, so the deadline loops end at once.
  let t = 0;
  const deps = { core, apps, log, now: () => t, sleep: async (ms: number) => { t += ms; } } as never;
  return { deps, created, deleted, core };
}

const input = { runId: 'abcdef12-0000-0000-0000-000000000000', sourceNode: 'src', targetNode: 'dst', pvcName: 'mail-stack-data', timeoutSeconds: 30 };

describe('runFinalStandbySync', () => {
  it('serves the quiet source volume on the source node and pulls it on the target node', async () => {
    const h = harness();
    const r = await runFinalStandbySync(h.deps, input);
    expect(r.ok).toBe(true);

    const pub = h.created.find((p) => p.metadata.labels?.app === FINAL_SYNC_PUBLISHER_APP)!;
    expect(pub.spec.nodeName).toBe('src');
    const pubJson = JSON.stringify(pub);
    expect(pubJson).toContain('"claimName":"mail-stack-data","readOnly":true');
    expect(pubJson).toContain('"image":"rsync-img:1"');                    // the cluster's own rsyncd image
    expect(pubJson).toContain('mail-stack-rsyncd-config');                 // same module/config as the sidecar

    const pull = h.created.find((p) => p.metadata.labels?.app === FINAL_SYNC_PULLER_APP)!;
    expect(pull.spec.nodeName).toBe('dst');
    const pullJson = JSON.stringify(pull);
    expect(pullJson).toContain('"image":"tools-img:2"');                   // the replicate DaemonSet's image
    expect(pullJson).toContain('"path":"/var/lib/mail-stack-standby"');
    expect(pullJson).toContain('{"name":"LOOP_INTERVAL_SECONDS","value":"0"}');
    expect(pullJson).toContain('rsync://10.42.1.7:873/mail-stack/');
  });

  it('always removes both pods, success or not', async () => {
    const ok = harness();
    await runFinalStandbySync(ok.deps, input);
    expect(ok.deleted.sort()).toEqual(ok.created.map((p) => p.metadata.name).sort());

    const bad = harness({ pullerPhase: 'Failed', pullerLog: 'rsync FAILED' });
    await runFinalStandbySync(bad.deps, input);
    expect(bad.deleted.sort()).toEqual(bad.created.map((p) => p.metadata.name).sort());
  });

  it('a failed pull is reported with the pod log tail (never a silent success)', async () => {
    const h = harness({ pullerPhase: 'Failed', pullerLog: 'line1\nstandby-replicate: rsync FAILED — partial copy' });
    const r = await runFinalStandbySync(h.deps, input);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('rsync FAILED') });
  });

  it('a publisher that never becomes Ready fails before anything is pulled', async () => {
    const h = harness({ publisherReady: false });
    const r = await runFinalStandbySync(h.deps, input);
    expect(r.ok).toBe(false);
    expect(h.created.some((p) => p.metadata.labels?.app === FINAL_SYNC_PULLER_APP)).toBe(false);
  });

  it('a pull still running at the deadline is a failure', async () => {
    const h = harness({ pullerPhase: 'Running' });
    const r = await runFinalStandbySync(h.deps, { ...input, timeoutSeconds: 1 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('did not finish') });
  });

  it('no replicate DaemonSet to borrow the image from → fails cleanly, creates nothing', async () => {
    const h = harness({ missingDaemonSet: true });
    const r = await runFinalStandbySync(h.deps, input);
    expect(r.ok).toBe(false);
    expect(h.created).toEqual([]);
  });

  it('honours an operator cancel while pulling (mail is down for this whole step)', async () => {
    const h = harness({ pullerPhase: 'Running' });
    let calls = 0;
    const deps = { ...(h.deps as object), cancelCheck: async () => ++calls > 2 } as never;
    const r = await runFinalStandbySync(deps, { ...input, timeoutSeconds: 1800 });
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(h.deleted.length).toBe(h.created.length);
  });

  it('honours a cancel before the publisher is even Ready, pulling nothing', async () => {
    const h = harness({ publisherReady: false });
    const deps = { ...(h.deps as object), cancelCheck: async () => true } as never;
    const r = await runFinalStandbySync(deps, input);
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(h.created.some((p) => p.metadata.labels?.app === FINAL_SYNC_PULLER_APP)).toBe(false);
  });

  it('never throws, even when the API does', async () => {
    const h = harness();
    (h.core.createNamespacedPod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('forbidden'));
    await expect(runFinalStandbySync(h.deps, input)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('forbidden') });
  });
});

describe('rsyncUrlFor', () => {
  it('brackets an IPv6 pod address', () => {
    expect(rsyncUrlFor('10.42.0.5')).toBe('rsync://10.42.0.5:873/mail-stack/');
    expect(rsyncUrlFor('fd00:10:42::5')).toBe('rsync://[fd00:10:42::5]:873/mail-stack/');
  });
});
