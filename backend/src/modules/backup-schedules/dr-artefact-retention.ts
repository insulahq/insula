/**
 * Days + keep-last for the three DR artefacts — etcd snapshots, secrets
 * bundles and cluster-state dumps — enforced from platform-api.
 *
 * Each artefact's Job prunes by COUNT after its own upload, and nothing pruned
 * by days at all: the cards offered no days field. That had two costs. A days
 * limit could not be expressed, and a changed count waited for the Job's next
 * run — for the nightly secrets and cluster-state Jobs, up to a day. This pass
 * applies the shared rule (retention-policy.ts) to what is actually on the
 * system class's target, on a short tick and right after the operator saves.
 *
 * The Jobs keep their count prune. They read the same count from the same
 * ConfigMap/env this module's sibling writes (`cadence/retention-configmap.ts`,
 * `backup-rclone-shim/etcd-cronjob.ts`), where "no count limit" is published
 * as 0 — which the scripts treat as "delete nothing". So the Job can only ever
 * remove a subset of what this pass removes, never something it keeps.
 *
 * Reached through the backup shim (the same LIST the system footprint uses),
 * so every target kind behind it — S3, SFTP, SMB — is handled alike. A
 * read-only (frozen) system target is never written to.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupTargetAssignments } from '../../db/schema.js';
import { requireWritableTarget, TargetFrozenError } from '../backup-config/writable-guard.js';
import { loadBackupTargetKey, SHIM_NAMESPACE } from '../backup-rclone-shim/service.js';
import { deriveShimAccessKey, deriveShimSecretKey } from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import { getClusterId } from '../system-settings/cluster-id.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import {
  describeRetention,
  loadRetention,
  selectForRemoval,
  type RetentionPolicy,
  type RetentionSubsystem,
} from './retention-policy.js';

export type DrArtefactSubsystem = Extract<RetentionSubsystem, 'etcd_snapshot' | 'secrets_bundle' | 'cluster_state'>;

export const DR_ARTEFACT_SUBSYSTEMS: readonly DrArtefactSubsystem[] = ['etcd_snapshot', 'secrets_bundle', 'cluster_state'];

export interface DrArtefactSpec {
  readonly subsystem: DrArtefactSubsystem;
  readonly bucket: string;
  /** Key prefix, ending in `/`. */
  readonly prefix: string;
  /** A key that IS a copy (not a companion or a stray file). */
  readonly isCopy: (key: string) => boolean;
  /** Keys deleted together with a copy. */
  readonly companions: (key: string) => readonly string[];
}

/**
 * Where each Job writes (k8s/base/backup/*-cronjob.yaml). The DR Jobs write
 * `s3://system/dr/<artefact>/` — bucket and `dr` prefix come from the
 * credentials Secret `dr-cronjobs.ts` writes; etcd writes per cluster id.
 */
export async function drArtefactSpecs(db: Database): Promise<readonly DrArtefactSpec[]> {
  const clusterId = await getClusterId(db);
  const none = (): readonly string[] => [];
  return [
    {
      subsystem: 'etcd_snapshot',
      bucket: 'system',
      prefix: `etcd/${clusterId}/`,
      isCopy: (k) => k.endsWith('.db'),
      companions: (k) => [`${k}.meta`],
    },
    {
      subsystem: 'secrets_bundle',
      bucket: 'system',
      prefix: 'dr/secrets/',
      isCopy: (k) => /\/secrets-[^/]+\.tar\.age$/.test(k),
      companions: none,
    },
    {
      subsystem: 'cluster_state',
      bucket: 'system',
      prefix: 'dr/cluster-state/',
      isCopy: (k) => /\/cluster-state-[^/]+\.tar\.gz$/.test(k),
      companions: none,
    },
  ];
}

export interface StoredObject {
  readonly key: string;
  readonly lastModified: Date;
}

/**
 * The keys to delete: every copy the policy removes, plus its companions.
 * Only direct children of the prefix count — a nested key is not this
 * artefact's (etcd's prefix also has the legacy per-host layout above it).
 */
export function planArtefactRemoval(
  spec: DrArtefactSpec,
  objects: readonly StoredObject[],
  policy: RetentionPolicy,
  now: Date,
): string[] {
  const present = new Set(objects.map((o) => o.key));
  const copies = objects
    .filter((o) => o.key.startsWith(spec.prefix) && !o.key.slice(spec.prefix.length).includes('/') && spec.isCopy(o.key))
    .map((o) => ({ createdAt: o.lastModified, key: o.key }));
  const keys: string[] = [];
  for (const c of selectForRemoval(copies, policy, now)) {
    keys.push(c.key);
    for (const companion of spec.companions(c.key)) if (present.has(companion)) keys.push(companion);
  }
  return keys;
}

export interface DrArtefactStore {
  list(bucket: string, prefix: string): Promise<StoredObject[]>;
  remove(bucket: string, key: string): Promise<void>;
}

export interface DrArtefactRetentionDeps {
  readonly specs: () => Promise<readonly DrArtefactSpec[]>;
  readonly loadPolicy: (subsystem: DrArtefactSubsystem) => Promise<RetentionPolicy>;
  readonly findSystemTargetId: () => Promise<string | null>;
  /** Throws TargetFrozenError for a read-only target. */
  readonly requireWritable: (targetId: string) => Promise<unknown>;
  readonly openStore: () => Promise<{ store: DrArtefactStore; close: () => void }>;
  readonly now: () => Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type DrArtefactOutcome =
  | { readonly subsystem: DrArtefactSubsystem; readonly state: 'applied'; readonly copies: number; readonly removed: number; readonly failed: number }
  | { readonly subsystem: DrArtefactSubsystem; readonly state: 'error'; readonly error: string };

export type DrArtefactRunResult =
  | { readonly state: 'skipped'; readonly reason: 'no-target' | 'frozen' }
  | { readonly state: 'ran'; readonly outcomes: readonly DrArtefactOutcome[] };

/** One pass over the requested artefacts (all three by default). */
export async function enforceDrArtefactRetention(
  deps: DrArtefactRetentionDeps,
  only: readonly DrArtefactSubsystem[] = DR_ARTEFACT_SUBSYSTEMS,
): Promise<DrArtefactRunResult> {
  const targetId = await deps.findSystemTargetId();
  if (!targetId) return { state: 'skipped', reason: 'no-target' };
  try {
    await deps.requireWritable(targetId);
  } catch (err) {
    if (err instanceof TargetFrozenError) return { state: 'skipped', reason: 'frozen' };
    throw err;
  }

  const specs = (await deps.specs()).filter((s) => only.includes(s.subsystem));
  const { store, close } = await deps.openStore();
  const outcomes: DrArtefactOutcome[] = [];
  try {
    for (const spec of specs) {
      try {
        const policy = await deps.loadPolicy(spec.subsystem);
        const objects = await store.list(spec.bucket, spec.prefix);
        const keys = planArtefactRemoval(spec, objects, policy, deps.now());
        const copies = objects.filter((o) => spec.isCopy(o.key)).length;
        let removed = 0;
        let failed = 0;
        for (const key of keys) {
          try {
            await store.remove(spec.bucket, key);
            if (spec.isCopy(key)) removed += 1;
          } catch (err) {
            failed += 1;
            deps.log.warn({ subsystem: spec.subsystem, key, err: err instanceof Error ? err.message : String(err) },
              'dr-artefact retention: delete failed — retried on the next tick');
          }
        }
        if (removed > 0 || failed > 0) {
          deps.log.info({ subsystem: spec.subsystem, keeping: describeRetention(policy), copies, removed, failed },
            'dr-artefact retention: applied');
        }
        outcomes.push({ subsystem: spec.subsystem, state: 'applied', copies, removed, failed });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        deps.log.warn({ subsystem: spec.subsystem, err: error }, 'dr-artefact retention: could not apply');
        outcomes.push({ subsystem: spec.subsystem, state: 'error', error });
      }
    }
  } finally {
    close();
  }
  return { state: 'ran', outcomes };
}

// ─── Real dependencies ──────────────────────────────────────────────────────

/** 1000 keys a page; the DR prefixes hold tens of objects, so this is a safety stop. */
const MAX_PAGES = 50;

async function openShimStore(core: k8s.CoreV1Api): Promise<{ store: DrArtefactStore; close: () => void }> {
  const key = await loadBackupTargetKey(core, SHIM_NAMESPACE);
  const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { NodeHttpHandler } = await import('@smithy/node-http-handler');
  const s3 = new S3Client({
    endpoint: SHIM_S3_ENDPOINT_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: deriveShimAccessKey(key.rawKey), secretAccessKey: deriveShimSecretKey(key.rawKey) },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({ requestTimeout: 120_000, connectionTimeout: 5_000 }),
    maxAttempts: 2,
  });
  const store: DrArtefactStore = {
    async list(bucket, prefix) {
      const out: StoredObject[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })) as {
          Contents?: ReadonlyArray<{ Key?: string; LastModified?: Date }>;
          NextContinuationToken?: string;
          IsTruncated?: boolean;
        };
        for (const o of res.Contents ?? []) {
          if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: new Date(o.LastModified) });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
        pages += 1;
        // A listing cut short could rank a copy as older than it is; refuse to
        // act on a partial one rather than delete from it.
        if (token && pages >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES * 1000} objects under ${bucket}/${prefix}`);
      } while (token);
      return out;
    },
    async remove(bucket, objectKey) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
  };
  return { store, close: () => s3.destroy() };
}

async function findSystemTargetId(db: Database): Promise<string | null> {
  const rows = await db
    .select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.backupClass, 'system'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return rows[0]?.targetId ?? null;
}

export function createDrArtefactRetentionDeps(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): DrArtefactRetentionDeps {
  return {
    specs: () => drArtefactSpecs(db),
    loadPolicy: (subsystem) => loadRetention(db, subsystem),
    findSystemTargetId: () => findSystemTargetId(db),
    requireWritable: (targetId) => requireWritableTarget(db, targetId),
    openStore: () => openShimStore(core),
    now: () => new Date(),
    log,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/** Short, so a changed limit shows within minutes even when another replica holds the lease. */
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

/** One leased run — the tick, and the accelerator the schedule route calls after a save. */
export async function runDrArtefactRetentionLeased(
  db: Database,
  deps: DrArtefactRetentionDeps,
  only?: readonly DrArtefactSubsystem[],
): Promise<DrArtefactRunResult | null> {
  const leased = await withSchedulerLease(db, 'dr-artefact-retention', TICK_INTERVAL_MS * 1.5,
    () => enforceDrArtefactRetention(deps, only), { log: deps.log });
  return leased.ran ? leased.value : null;
}

export function startDrArtefactRetentionScheduler(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): { stop: () => void } {
  const deps = createDrArtefactRetentionDeps(db, core, log);
  const tick = async (): Promise<void> => {
    try {
      await runDrArtefactRetentionLeased(db, deps);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'dr-artefact retention: tick threw');
    }
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    interval.unref?.();
  }, INITIAL_DELAY_MS);
  first.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
