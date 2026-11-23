/**
 * The fast down-watch's own memory of the outages it announced.
 *
 * The all-clear hangs on one database field, `node_health_state.down_since`
 * (back-online.ts). On production one outage lost it twice over: one pod could
 * not write it because the platform database was failing over, and the other
 * wrote it over a connection still held by the old primary, whose writes
 * pg_rewind threw away when it rejoined. The "down" email had gone out; no
 * "back" email ever followed.
 *
 * So the pod whose going-down notice reached someone keeps the outage itself
 * until it is over:
 *   - while the node stays NotReady, it writes the record again when it is
 *     missing, so the reconciler and the other pods can still close it and the
 *     startup notice can still count the downtime;
 *   - when the node is Ready again on the same boot and no record is left on
 *     two ticks running, it sends the all-clear itself, under the claim path's
 *     key (nodeBackDedupeKey). The second tick is for a detector that claimed
 *     the record and is still sending: by then its delivery is on record, and
 *     the dispatcher skips this one as a duplicate.
 * A going-down notice whose dispatch failed outright is kept as well, and sent
 * again on the next tick while the node is still down. The database being away
 * is the likeliest cause, and a node that holds the database primary is the
 * one whose outage takes it away.
 *
 * In memory only: a platform-api restart forgets it, and the record in the
 * database is then the only one, as before. Pure; the watch does the writes.
 */
import type { NoticeOutcome } from '../notifications/events.js';
import { endedOnSameBoot, type LiveNodeState, type SameBootReturn } from './back-online.js';

/** One outage this pod announced, for as long as it lasts. */
export interface AnnouncedOutage {
  readonly nodeName: string;
  readonly bootId: string | null;
  /** When it left Ready (boot-events.ts wentDownAt). */
  readonly downAt: Date;
  readonly shuttingDown: boolean;
  /** The going-down notice's dedupe key, reused when it is sent again. */
  readonly downKey: string;
  /** The going-down notice reached someone. Until it has, no all-clear can follow. */
  readonly told: boolean;
  /** Seen back on the previous tick with no record left: the all-clear is due now. */
  readonly backUnrecorded: boolean;
}

/**
 * Add an announcement to what is remembered, by what its notice came to. A
 * notice nobody was due (another pod already told them, or nobody wants it)
 * is not this pod's to follow: the pod that told them keeps it.
 */
export function rememberAnnouncement(
  remembered: ReadonlyMap<string, AnnouncedOutage>,
  a: Omit<AnnouncedOutage, 'told' | 'backUnrecorded'>,
  outcome: NoticeOutcome | undefined,
): ReadonlyMap<string, AnnouncedOutage> {
  if (outcome !== 'told' && outcome !== 'failed') return remembered;
  return new Map(remembered).set(a.nodeName, { ...a, told: outcome === 'told', backUnrecorded: false });
}

/**
 * What a going-down notice sent AGAIN came to. Nobody due one now still means
 * someone was told: the attempt that failed may have reached some recipients
 * before it did, and a retry then finds them all told under the key.
 */
export function afterResend(o: AnnouncedOutage, outcome: NoticeOutcome): AnnouncedOutage {
  return outcome === 'failed' ? o : { ...o, told: true };
}

export interface AnnouncedOutageStep {
  /** Still down, its going-down notice never sent: send it again. */
  readonly resend: readonly AnnouncedOutage[];
  /** Still down, and no outage on record for it: write the record again. */
  readonly restore: readonly AnnouncedOutage[];
  /** Back on the same boot, no record left to claim: this pod sends the all-clear. */
  readonly allClear: ReadonlyArray<{ readonly outage: AnnouncedOutage; readonly back: SameBootReturn }>;
  /** What to remember for the next tick. */
  readonly next: ReadonlyMap<string, AnnouncedOutage>;
}

/**
 * One tick. `onRecord` holds the nodes with an outage open in the database —
 * null when it could not be read, and then nothing is decided from it.
 * `closedHere` holds the ones this pod's claim has just closed and announced.
 *
 * A node on a NEW boot is dropped, down or back: the reconciler's startup
 * notice reports a reboot. So is one whose going-down notice never reached
 * anyone once it is back, and a shutdown: neither has a "down" for an all-clear
 * to answer.
 */
export function planAnnouncedOutages(
  remembered: ReadonlyMap<string, AnnouncedOutage>,
  live: ReadonlyMap<string, LiveNodeState>,
  onRecord: ReadonlySet<string> | null,
  closedHere: ReadonlySet<string>,
): AnnouncedOutageStep {
  const resend: AnnouncedOutage[] = [];
  const restore: AnnouncedOutage[] = [];
  const allClear: Array<{ outage: AnnouncedOutage; back: SameBootReturn }> = [];
  const next = new Map<string, AnnouncedOutage>();
  for (const o of remembered.values()) {
    const node = live.get(o.nodeName);
    if (!node) continue;
    if (o.bootId && node.bootId && o.bootId !== node.bootId) continue;
    if (!node.ready) {
      next.set(o.nodeName, { ...o, backUnrecorded: false });
      if (!o.told) resend.push(o);
      if (onRecord !== null && !onRecord.has(o.nodeName)) restore.push(o);
      continue;
    }
    if (!o.told || o.shuttingDown || closedHere.has(o.nodeName)) continue;
    // Unreadable, or still on record: the claim path (here or in another pod)
    // closes it. Kept, so a later tick can still answer it if it never does.
    if (onRecord === null || onRecord.has(o.nodeName)) {
      next.set(o.nodeName, { ...o, backUnrecorded: false });
      continue;
    }
    const back = endedOnSameBoot({ nodeName: o.nodeName, downSince: o.downAt, bootId: o.bootId }, node);
    if (!back) continue;
    if (o.backUnrecorded) allClear.push({ outage: o, back });
    else next.set(o.nodeName, { ...o, backUnrecorded: true });
  }
  return { resend, restore, allClear, next };
}
