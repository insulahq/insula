/**
 * Stalwart stdout-tracer provisioning.
 *
 * Stalwart ships ONE tracer by default: `@type: "Log"` writing to
 * `/var/log/stalwart`. In our container that directory does not exist
 * and is not a mounted volume, so the mail server produced **no logs
 * at all** — nothing on disk, nothing on stdout, nothing in
 * `kubectl logs`. Measured on DEV: zero log lines in the
 * pod's entire 7-hour life while it was actively accepting SMTP.
 *
 * That blindness is not a cosmetic problem. It is what made a real
 * delivery outage (an outbound rate limit silently parking 82 LOCAL
 * messages) take hours to find: every other surface reported success,
 * and the one component that knew the reason was not saying it.
 *
 * So: ensure exactly one platform-managed `Stdout` tracer exists, at
 * `info`, so the container's logs reach the normal Kubernetes path.
 * The default `Log` tracer is left alone — it is inert (its directory
 * is absent) and it is not ours to remove.
 *
 * Unlike x:WebHook, a tracer change takes effect on ReloadSettings
 * alone — no pod roll (verified live: `kubectl logs` began producing
 * output seconds after the reload, with no restart).
 */

import {
  tracerGet,
  tracerSet,
  actionReloadSettings,
  type StalwartTracerRow,
} from '../stalwart-jmap/client.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export const TRACER_TYPE = 'Stdout';
export const TRACER_LEVEL = 'info';

/** The object we want present. `events: {}` + exclude = "everything at level". */
export function desiredStdoutTracer(): Record<string, unknown> {
  return {
    '@type': TRACER_TYPE,
    enable: true,
    level: TRACER_LEVEL,
    ansi: false,
    multiline: false,
    lossy: false,
    events: {},
    eventsPolicy: 'exclude',
  };
}

/** Pure: what (if anything) must change, given what Stalwart currently has. */
export function planStdoutTracer(
  existing: readonly StalwartTracerRow[],
): { action: 'create' } | { action: 'enable'; id: string } | { action: 'none' } {
  const mine = existing.filter((t) => t['@type'] === TRACER_TYPE);
  if (mine.length === 0) return { action: 'create' };
  const live = mine.find((t) => t.enable && t.level === TRACER_LEVEL);
  if (live) return { action: 'none' };
  return { action: 'enable', id: mine[0].id };
}

export async function ensureStalwartStdoutTracer(
  logger: OutboundReconcileLogger,
): Promise<{ changed: boolean }> {
  let existing: readonly StalwartTracerRow[];
  try {
    existing = await tracerGet({});
  } catch (err) {
    logger.warn({ err }, 'stdout tracer ensure: Stalwart JMAP unreachable, skipped');
    return { changed: false };
  }

  const plan = planStdoutTracer(existing);
  if (plan.action === 'none') return { changed: false };

  try {
    if (plan.action === 'create') {
      const res = await tracerSet({ create: { stdout: desiredStdoutTracer() } });
      if (res.notCreated && Object.keys(res.notCreated).length > 0) {
        logger.warn({ notCreated: res.notCreated }, 'stdout tracer create rejected');
        return { changed: false };
      }
      logger.info({}, 'stdout tracer created — mail logs now reach kubectl logs');
    } else {
      const res = await tracerSet({
        update: { [plan.id]: { enable: true, level: TRACER_LEVEL } },
      });
      if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
        logger.warn({ notUpdated: res.notUpdated }, 'stdout tracer update rejected');
        return { changed: false };
      }
      logger.info({ id: plan.id }, 'stdout tracer re-enabled');
    }
    await actionReloadSettings({});
    return { changed: true };
  } catch (err) {
    logger.warn({ err }, 'stdout tracer ensure failed');
    return { changed: false };
  }
}
