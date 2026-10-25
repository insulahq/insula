/**
 * "Node back online" — the all-clear for an outage that ended on the SAME boot.
 *
 * A node that drops out for a minute and comes back without rebooting used to
 * get a "down" email and nothing after it. The fast down-watch (30 s) announces
 * the outage; the only back notice for a same-boot return was the 5-minute
 * reconciler's severity change ("recovered to normal"), and the reconciler
 * never sees an outage that falls between two of its ticks. Measured on
 * production: NotReady for ~70 s, "down" email sent one second before it was
 * Ready again, no all-clear ever.
 *
 * `node_health_state.down_since` is the shared record of an outage in
 * progress: the fast watch writes it when it announces the node, the reconciler
 * when it sees the node NotReady outside its join window. Whichever detector
 * first sees the node Ready again on the same boot clears it — compare-and-clear,
 * so exactly one of them (in one platform-api pod) sends the notice. A return on
 * a NEW boot is the reconciler's "startup complete" notice, not this one.
 *
 * Pure apart from the two small DB helpers at the bottom.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeHealthState } from '../../db/schema.js';
import { notifyAdminNodeBackOnline } from '../notifications/events.js';
import { formatDowntime } from './boot-events.js';

/** An outage on record: a `node_health_state` row with `down_since` set. */
export interface OpenOutage {
  readonly nodeName: string;
  readonly downSince: Date;
  /** The boot the row was recorded on; null when none was ever recorded. */
  readonly bootId: string | null;
}

/** The node as the Node list shows it right now. */
export interface LiveNodeState {
  readonly ready: boolean;
  /** Ready condition `lastTransitionTime`: when it last became Ready. */
  readonly readySince: Date | null;
  readonly bootId: string | null;
}

export interface SameBootReturn {
  readonly nodeName: string;
  readonly bootId: string | null;
  readonly downSince: Date;
  readonly backAt: Date;
  /** Both boot IDs on record and equal — only then is "it did not reboot" known. */
  readonly sameBootKnown: boolean;
}

/**
 * The open outage has ended on the boot it began on.
 *
 * `readySince > downSince` is what makes it an END: a Node list read before the
 * node went down still says Ready, with an older transition time, and must not
 * close an outage recorded after it. A changed bootID is a reboot — the startup
 * notice reports that one. An unrecorded boot on either side cannot be told
 * apart from a reboot, and then this notice is the only one that can go out
 * (startup-complete needs both IDs too), so it goes out.
 */
export function endedOnSameBoot(outage: OpenOutage, live: LiveNodeState | undefined): SameBootReturn | null {
  if (!live?.ready || !live.readySince) return null;
  if (live.readySince.getTime() <= outage.downSince.getTime()) return null;
  if (outage.bootId && live.bootId && outage.bootId !== live.bootId) return null;
  return {
    nodeName: outage.nodeName,
    bootId: live.bootId ?? outage.bootId,
    downSince: outage.downSince,
    backAt: live.readySince,
    sameBootKnown: Boolean(outage.bootId && live.bootId),
  };
}

/**
 * Per (node × boot × day the outage began) — the same grain as the going-down
 * key (fast-down-watch.ts nodeDownDedupeKey), so a node that flaps on one boot
 * gets one "down" and one "back" a day, not a "back" for every flap whose
 * "down" was deduplicated away.
 */
export function nodeBackDedupeKey(nodeName: string, bootId: string | null, downSince: Date): string {
  return `node-back:${nodeName}:${bootId ?? 'unknown-boot'}:${downSince.toISOString().slice(0, 10)}`;
}

function utcClock(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/** The notice's variables, rendered. */
export function backOnlinePayload(r: SameBootReturn): {
  nodeName: string; downtimeText: string; downAtText: string; backAtText: string; bootNote: string;
} {
  return {
    nodeName: r.nodeName,
    downtimeText: formatDowntime(r.backAt.getTime() - r.downSince.getTime()),
    downAtText: utcClock(r.downSince),
    backAtText: utcClock(r.backAt),
    bootNote: r.sameBootKnown
      ? 'The host did not reboot: it lost contact with the cluster and recovered on its own, which usually means a short network outage between it and the other servers.'
      : 'Whether the host rebooted is not known: no boot ID was on record for it.',
  };
}

/** Outages on record, for the fast watch's per-tick check. */
export async function readOpenOutages(db: Database): Promise<OpenOutage[]> {
  const rows = await db
    .select({ nodeName: nodeHealthState.nodeName, downSince: nodeHealthState.downSince, bootId: nodeHealthState.bootId })
    .from(nodeHealthState)
    .where(isNotNull(nodeHealthState.downSince));
  return rows
    .filter((r): r is typeof r & { downSince: Date } => r.downSince instanceof Date)
    .map((r) => ({ nodeName: r.nodeName, downSince: r.downSince, bootId: r.bootId ?? null }));
}

/**
 * Close the outage if it is still the one on record, and say whether THIS
 * caller closed it. Two detectors in up to three platform-api pods race for
 * the same return; only the one whose UPDATE matched sends the notice.
 */
export async function claimOutageEnd(db: Database, nodeName: string, downSince: Date): Promise<boolean> {
  const rows = await db
    .update(nodeHealthState)
    .set({ downSince: null })
    .where(and(
      eq(nodeHealthState.nodeName, nodeName),
      sql`${nodeHealthState.downSince} = ${downSince.toISOString()}::timestamptz`,
    ))
    .returning({ nodeName: nodeHealthState.nodeName });
  return rows.length > 0;
}

/** Claim the return and, when this caller won it, send the all-clear. */
export async function announceSameBootReturn(db: Database, r: SameBootReturn): Promise<boolean> {
  if (!(await claimOutageEnd(db, r.nodeName, r.downSince))) return false;
  await notifyAdminNodeBackOnline(db, backOnlinePayload(r), nodeBackDedupeKey(r.nodeName, r.bootId, r.downSince));
  return true;
}
