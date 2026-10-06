/**
 * Monitoring → Traffic as a linkable view.
 *
 * The tab reads its INITIAL state from the query string, so another page can
 * open it on a specific question — the tenant page's Traffic card links to
 * `/monitoring?scope=tenant&subject=<namespace>&range=7d`. Anything missing or
 * not recognised falls back to the tab's own default rather than erroring: a
 * stale bookmark should land on a working view.
 */

import { TRAFFIC_METRICS, type TrafficMetric, type TrafficScope } from '@insula/api-contracts';
import { RANGE_PRESETS } from './TrafficRangePicker';

/** The scopes the Traffic tab offers (its picker). `backup-class` is not one. */
export const TAB_SCOPES = ['cluster', 'node', 'tenant', 'pod', 'route'] as const satisfies readonly TrafficScope[];
export type TabScope = (typeof TAB_SCOPES)[number];

export const DEFAULT_RANGE_PRESET = '24h';

export interface TrafficUrlState {
  readonly scope: TabScope;
  /** Node, tenant namespace or route — what `scope` breaks down by; for `pod`, the tenant. */
  readonly subject: string | null;
  readonly pod: string | null;
  readonly metric: TrafficMetric;
  /** A RANGE_PRESETS key. */
  readonly range: string;
}

/** Same bound the API puts on a subject. */
const MAX_SUBJECT_LENGTH = 253;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function cleanSubject(value: string | null): string | null {
  const v = value?.trim() ?? '';
  return v.length > 0 && v.length <= MAX_SUBJECT_LENGTH ? v : null;
}

/** Pure: the tab's initial state from a `?…` query string. */
export function parseTrafficUrlState(search: string): TrafficUrlState {
  const q = new URLSearchParams(search);
  const scope = oneOf(q.get('scope'), TAB_SCOPES) ?? 'cluster';
  const range = oneOf(q.get('range'), RANGE_PRESETS.map((p) => p.key)) ?? DEFAULT_RANGE_PRESET;
  // A cluster view has no subject; carrying one over would filter nothing
  // visible and silently change the query.
  const subject = scope === 'cluster' ? null : cleanSubject(q.get('subject'));
  const pod = scope === 'pod' ? cleanSubject(q.get('pod')) : null;
  // Pod scope answers traffic only (Traefik has no per-pod dimension).
  const askedMetric = oneOf(q.get('metric'), TRAFFIC_METRICS) ?? 'traffic';
  const metric: TrafficMetric = scope === 'pod' ? 'traffic' : askedMetric;
  return { scope, subject, pod, metric, range };
}

/** The Traffic tab URL for a view. Defaults are left out so the link stays short. */
export function trafficTabUrl(view: Partial<TrafficUrlState>): string {
  const q = new URLSearchParams();
  if (view.scope && view.scope !== 'cluster') q.set('scope', view.scope);
  if (view.subject) q.set('subject', view.subject);
  if (view.pod) q.set('pod', view.pod);
  if (view.metric && view.metric !== 'traffic') q.set('metric', view.metric);
  if (view.range && view.range !== DEFAULT_RANGE_PRESET) q.set('range', view.range);
  const qs = q.toString();
  return qs ? `/monitoring?${qs}` : '/monitoring';
}
