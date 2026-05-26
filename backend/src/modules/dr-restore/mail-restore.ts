/**
 * DR full-mode mail data restore (Unit C.2).
 *
 * Mail data lives on the consolidated `mail-stack-data` PVC (Stalwart
 * RocksDB DataStore + Bulwark settings + admin DB). After bootstrap,
 * this PVC contains fresh-started data (Stalwart initContainer ran
 * without the `allow-restore` annotation set + no Secret present, so
 * it fresh-started with default settings).
 *
 * For DR full-mode we need to:
 *   1. Confirm `stalwart-snapshot-restic-repo` Secret exists — operator
 *      must have run `make secrets-restore` first. Without it the
 *      Stalwart/Bulwark initContainers' RESTIC_REPOSITORY env stays empty
 *      and the restore-state script will fresh-start AGAIN instead of
 *      restic-restoring.
 *   2. Wipe the mail PVC + restart pods with the `allow-restore` gate
 *      stamped on Stalwart's pod template.
 *
 * For (2) we delegate to the existing `triggerRestoreBasedFailover`
 * primitive in mail-admin/migration.ts. It's the proven path that
 * already handles:
 *   - Scale Stalwart + Bulwark to 0 (drain pods)
 *   - Wait for pods gone
 *   - Delete + recreate the `mail-stack-data` PVC
 *   - Stamp `mail.platform/allow-restore=true` on the Stalwart pod
 *     template (NOT on Bulwark — Bulwark auto-restores when sentinel
 *     `admin.json` is absent)
 *   - Scale Deployments back up
 *   - InitContainers (in k8s/base/stalwart-mail + k8s/base/bulwark)
 *     run restic-restore against the offsite repo
 *   - Verify rollout
 *   - Clear the allow-restore annotation post-success
 *
 * Operator-facing contract:
 *   - `--target-mail-node=<name>` REQUIRED. We don't auto-pick because
 *     in DR the operator may have intentionally provisioned mail on a
 *     specific node (e.g. the only node with enough free disk).
 *   - System-settings (mailActiveNode, mailPortMode, etc.) are NOT
 *     imported by DR partial-mode. `triggerRestoreBasedFailover` reads
 *     mailActiveNode for the audit row only; a fresh DB has it as null
 *     and the function treats that as `unknown` — non-fatal.
 *
 * Not in this module:
 *   - Choosing the target node (operator responsibility — CLI flag).
 *   - Verifying the restic repo URL points at the OLD cluster's archive
 *     (the Secret is opaque to us; the operator's `make secrets-restore`
 *     applies the OLD Secret values from the bundle).
 *   - System-settings restore (deliberately deferred to operator UI).
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { triggerRestoreBasedFailover } from '../mail-admin/migration.js';
import type { Database } from '../../db/index.js';

const MAIL_NAMESPACE = 'mail';
const RESTIC_SECRET_NAME = 'stalwart-snapshot-restic-repo';

export class MailRestoreError extends Error {
  readonly code: number;
  constructor(message: string, code = 500) {
    super(message);
    this.name = 'MailRestoreError';
    this.code = code;
  }
}

export interface MailRestoreOpts {
  readonly db: Database;
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
  readonly batch: k8s.BatchV1Api;
  /** Target node for the mail-stack to land on after the restore.
   *  Operator-supplied via `--target-mail-node`. */
  readonly targetMailNode: string;
  /** Optional kubeconfig path forwarded to the migration state machine
   *  for any operations that need to spawn one-off Jobs. */
  readonly kubeconfigPath?: string;
  /** Test-only override: substitute triggerRestoreBasedFailover with
   *  a stub. */
  readonly _failoverImpl?: typeof triggerRestoreBasedFailover;
}

export interface MailRestoreResult {
  /** Wall-clock duration of the failover state machine. */
  readonly durationMs: number;
  /** Node the mail-stack is now pinned to. */
  readonly targetMailNode: string;
}

/**
 * Validate that the operator's `make secrets-restore` step has applied
 * the restic-repo Secret. We don't inspect its contents — the Secret is
 * opaque to us — but a 404 here is a clean fail-fast that prevents the
 * pods from fresh-starting AGAIN after the PVC wipe.
 */
async function preflightResticSecret(core: k8s.CoreV1Api): Promise<void> {
  try {
    await core.readNamespacedSecret({
      namespace: MAIL_NAMESPACE, name: RESTIC_SECRET_NAME,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new MailRestoreError(
        `Secret ${MAIL_NAMESPACE}/${RESTIC_SECRET_NAME} not found. Run 'make secrets-restore BUNDLE=... KEY=...' BEFORE DR full-mode mail restore — without it the Stalwart/Bulwark initContainers will fresh-start instead of restic-restoring.`,
        412,
      );
    }
    throw err;
  }
}

/**
 * Validate that the operator's chosen node is Ready. If we wipe the PVC
 * and pin to a non-Ready node, the pods stay Pending forever and the
 * operator has to manually patch the affinity to recover.
 */
async function preflightTargetNode(core: k8s.CoreV1Api, name: string): Promise<void> {
  let node: { readonly status?: { readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }> } };
  try {
    node = await core.readNode({ name } as unknown as Parameters<typeof core.readNode>[0]) as unknown as typeof node;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new MailRestoreError(
        `Target mail node '${name}' not found. Check with: kubectl get nodes`,
        412,
      );
    }
    throw err;
  }
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') {
    throw new MailRestoreError(
      `Target mail node '${name}' is not Ready (Ready condition status=${ready?.status ?? '<none>'}). Pick a different node.`,
      412,
    );
  }
}

/**
 * Public entry. Runs preflight + invokes the existing migration state
 * machine (skipFreshSnapshot=true) to do the destructive PVC swap +
 * restic-restore cycle.
 */
export async function restoreMailData(
  opts: MailRestoreOpts,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<MailRestoreResult> {
  if (!opts.targetMailNode || opts.targetMailNode.length === 0) {
    throw new MailRestoreError('targetMailNode is required (operator must pass --target-mail-node=<name>)', 400);
  }

  await preflightResticSecret(opts.core);
  await preflightTargetNode(opts.core, opts.targetMailNode);

  log?.info?.({ targetMailNode: opts.targetMailNode }, 'dr-mail-restore: preflight OK, starting migration state machine');

  const startedAt = Date.now();
  const impl = opts._failoverImpl ?? triggerRestoreBasedFailover;
  try {
    await impl(opts.targetMailNode, {
      db: opts.db,
      core: opts.core,
      apps: opts.apps,
      batch: opts.batch,
      kubeconfigPath: opts.kubeconfigPath,
    });
  } catch (err) {
    throw new MailRestoreError(
      `Mail restore failover state machine failed: ${err instanceof Error ? err.message : String(err)}. Inspect with: kubectl -n mail get pods + SELECT * FROM mail_migration_runs ORDER BY started_at DESC LIMIT 1`,
      500,
    );
  }
  const durationMs = Date.now() - startedAt;

  log?.info?.(
    { targetMailNode: opts.targetMailNode, durationMs },
    'dr-mail-restore: state machine completed, mail-stack restored',
  );

  return { durationMs, targetMailNode: opts.targetMailNode };
}
