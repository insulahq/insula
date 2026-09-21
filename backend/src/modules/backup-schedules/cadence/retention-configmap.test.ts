/**
 * Retention for the Flux-owned DR CronJobs.
 *
 * The number the operator sets has to reach a job whose object Flux owns and
 * reverts. It does so through a ConfigMap the platform owns exclusively, which
 * the job reads with `envFrom … optional: true` — the same arrangement the
 * mail snapshot uses, for the same reason.
 *
 * What matters most here is the value that must NEVER be published. These
 * counts drive a delete loop, so "keep 0" would mean "delete the entire
 * history". The scripts guard themselves too, but a writer that can emit a
 * destructive number and relies on the reader to ignore it is one script edit
 * away from being destructive.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RETENTION_CONFIGMAP_TARGETS,
  retentionTargetFor,
  desiredRetentionCount,
  applyRetentionConfigMap,
} from './retention-configmap.js';
import type { Database } from '../../../db/index.js';

const SECRETS = retentionTargetFor('secrets_bundle')!;

function dbWith(retentionCount: number | null | undefined) {
  return {
    select: () => ({ from: () => ({ where: async () => (retentionCount === undefined ? [] : [{ retentionCount }]) }) }),
  } as unknown as Database;
}

function core(opts: { exists: boolean; failCreate?: boolean; failReplace?: boolean }) {
  const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
  const calls: string[] = [];
  return {
    calls,
    client: {
      readNamespacedConfigMap: async () => {
        calls.push('read');
        if (!opts.exists) throw notFound;
        return {};
      },
      replaceNamespacedConfigMap: async (a: { body: { data?: Record<string, string> } }) => {
        calls.push(`replace:${a.body.data?.RETENTION_COUNT}`);
        if (opts.failReplace) throw new Error('boom');
        return {};
      },
      createNamespacedConfigMap: async (a: { body: { data?: Record<string, string> } }) => {
        calls.push(`create:${a.body.data?.RETENTION_COUNT}`);
        if (opts.failCreate) throw new Error('boom');
        return {};
      },
    },
  };
}

describe('desiredRetentionCount', () => {
  it('uses the operator value when it is a sane count', async () => {
    expect(await desiredRetentionCount(dbWith(7), SECRETS)).toBe(7);
  });

  it('falls back to the job default when nothing is configured', async () => {
    // NULL means "never set", which is the number the job already runs — not
    // zero.
    expect(await desiredRetentionCount(dbWith(null), SECRETS)).toBe(SECRETS.defaultCount);
    expect(await desiredRetentionCount(dbWith(undefined), SECRETS)).toBe(SECRETS.defaultCount);
  });

  it('REFUSES to publish zero or a negative count', async () => {
    // The one value that would turn a retention setting into a delete-all.
    expect(await desiredRetentionCount(dbWith(0), SECRETS)).toBe(SECRETS.defaultCount);
    expect(await desiredRetentionCount(dbWith(-5), SECRETS)).toBe(SECRETS.defaultCount);
  });

  it('refuses a non-integer', async () => {
    expect(await desiredRetentionCount(dbWith(2.5), SECRETS)).toBe(SECRETS.defaultCount);
  });
});

describe('applyRetentionConfigMap', () => {
  it('replaces an existing ConfigMap', async () => {
    const c = core({ exists: true });
    expect(await applyRetentionConfigMap(dbWith(9), c.client, SECRETS)).toBe(9);
    expect(c.calls).toEqual(['read', 'replace:9']);
  });

  it('creates one when absent', async () => {
    const c = core({ exists: false });
    expect(await applyRetentionConfigMap(dbWith(9), c.client, SECRETS)).toBe(9);
    expect(c.calls).toEqual(['read', 'create:9']);
  });

  it('reports failure instead of throwing', async () => {
    // A ConfigMap the cluster refused leaves the job on its previous number —
    // a stale retention, not a stopped backup. It must not fail the cadence
    // pass it rides along with.
    const warn = vi.fn();
    const c = core({ exists: false, failCreate: true });
    expect(await applyRetentionConfigMap(dbWith(9), c.client, SECRETS, { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('targets', () => {
  it('covers exactly the two Flux-owned DR jobs', async () => {
    // etcd is absent on purpose: the platform owns that CronJob outright and
    // patches its env directly, so it needs no ConfigMap.
    expect(RETENTION_CONFIGMAP_TARGETS.map((t) => t.subsystem).sort())
      .toEqual(['cluster_state', 'secrets_bundle']);
  });

  it('defaults match the numbers compiled into the job scripts', async () => {
    // Read out of the manifests rather than restated here. If they disagree,
    // the number the panel shows before an operator first saves is not the
    // number the job is running — and a test that restated the constant would
    // stay green through exactly that drift.
    const manifestDefault = (file: string): number => {
      const yaml = readFileSync(fileURLToPath(
        new URL(`../../../../../k8s/base/backup/${file}`, import.meta.url),
      ), 'utf8');
      const m = /RETENTION_COUNT:-(\d+)/.exec(yaml);
      expect(m, `${file} has no RETENTION_COUNT default`).toBeTruthy();
      return Number(m![1]);
    };
    expect(retentionTargetFor('secrets_bundle')!.defaultCount)
      .toBe(manifestDefault('secrets-backup-cronjob.yaml'));
    expect(retentionTargetFor('cluster_state')!.defaultCount)
      .toBe(manifestDefault('cluster-state-cronjob.yaml'));
  });

  it('the etcd reconciler default matches its manifest too', async () => {
    const { ETCD_DEFAULT_RETENTION_COUNT } = await import('../../backup-rclone-shim/etcd-cronjob.js');
    const yaml = readFileSync(fileURLToPath(
      new URL('../../../../../k8s/base/backup/etcd-snap-via-shim-cronjob.yaml', import.meta.url),
    ), 'utf8');
    const m = /RETENTION_COUNT:-(\d+)/.exec(yaml);
    expect(Number(m![1])).toBe(ETCD_DEFAULT_RETENTION_COUNT);
  });
});
