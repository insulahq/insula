/**
 * What the panels call a node: its alias (`cluster_nodes.display_name`) when
 * the operator set one, else its Kubernetes name.
 *
 * Kubernetes names are whatever the host was called at install —
 * `sv2.cluster.example.test` — and the alias exists so operators read
 * "Secondary" instead. Every surface that names a node reads it from here:
 * the panels through GET /admin/node-labels, server-built text (notifications,
 * dashboard tiles, tenant issues) through `aliasNodeNames`.
 *
 * A node is also known by its short hostname (`kubernetes.io/hostname`), which
 * some sources report instead of the Kubernetes name; both map to the alias.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

export interface NodeLabelRow {
  readonly name: string;
  readonly displayName: string | null;
  readonly hostname: string | null;
}

export interface NodeLabels {
  /** name or hostname → alias, for nodes that have one. */
  readonly aliases: ReadonlyMap<string, string>;
  /** Every node, for the panels: name, hostname and what to show. */
  readonly rows: readonly { readonly name: string; readonly hostname: string | null; readonly label: string }[];
}

/** Pure. A blank alias counts as unset. */
export function buildNodeLabels(rows: readonly NodeLabelRow[]): NodeLabels {
  const aliases = new Map<string, string>();
  const out: Array<{ name: string; hostname: string | null; label: string }> = [];
  for (const r of rows) {
    const alias = r.displayName?.trim() || null;
    if (alias) {
      aliases.set(r.name, alias);
      if (r.hostname && r.hostname !== r.name) aliases.set(r.hostname, alias);
    }
    out.push({ name: r.name, hostname: r.hostname, label: alias ?? r.name });
  }
  return { aliases, rows: out };
}

/** The alias for a node name or hostname, else the name itself. */
export function nodeLabel(name: string, labels: NodeLabels): string {
  return labels.aliases.get(name) ?? name;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One compiled pattern per label set — a task list or alert section aliases many strings. */
const patterns = new WeakMap<NodeLabels, RegExp>();
function patternFor(labels: NodeLabels): RegExp {
  let re = patterns.get(labels);
  if (!re) {
    const names = [...labels.aliases.keys()].sort((a, b) => b.length - a.length);
    re = new RegExp(`(?<![A-Za-z0-9.-])(${names.map(escapeRegExp).join('|')})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'g');
    patterns.set(labels, re);
  }
  return re;
}

/**
 * Replace every node name (or hostname) that has an alias inside free text.
 * Only whole names: `sv1` is not replaced inside `sv10`, `pvc-sv1` or
 * `sv1.other.test` — a node name is bounded by anything but a name character.
 * Longest names first, so an FQDN wins over its own short hostname. A
 * `code span` is left alone: it is something to type, and `kubectl` only
 * knows the real name. The admin panel mirrors this in `nodeTextAliaser`.
 */
export function aliasNodeNames(text: string, labels: NodeLabels): string {
  if (labels.aliases.size === 0 || !text) return text;
  const re = patternFor(labels);
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(re, (m) => labels.aliases.get(m) ?? m)))
    .join('');
}

/** Keys and values that address something rather than describe it — never rewritten. */
const ADDRESS_KEY = /(url|href|link|path)$/i;
const ADDRESS_VALUE = /^(https?:\/\/|\/)/;

/**
 * `aliasNodeNames` over every string value of a variables bag — except links
 * and paths: `/cluster/nodes/sv1` must keep naming the node Kubernetes knows. Pure.
 */
export function aliasNodeNamesInVariables(vars: Readonly<Record<string, unknown>>, labels: NodeLabels): Record<string, unknown> {
  if (labels.aliases.size === 0) return { ...vars };
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [
    k,
    typeof v === 'string' && !ADDRESS_KEY.test(k) && !ADDRESS_VALUE.test(v) ? aliasNodeNames(v, labels) : v,
  ]));
}

/** A task row's words — label, progress line, error — with node aliases. Pure. */
export function aliasTaskText<T extends { label?: string; progressText?: string | null; errorMessage?: string | null }>(
  task: T,
  labels: NodeLabels,
): T {
  if (labels.aliases.size === 0) return task;
  const alias = (t: string | null | undefined): string | null | undefined => (t ? aliasNodeNames(t, labels) : t);
  return {
    ...task,
    ...(task.label !== undefined ? { label: alias(task.label) as string } : {}),
    ...(task.progressText !== undefined ? { progressText: alias(task.progressText) } : {}),
    ...(task.errorMessage !== undefined ? { errorMessage: alias(task.errorMessage) } : {}),
  };
}

const CACHE_MS = 30_000;
let cache: { at: number; value: NodeLabels } | null = null;

/**
 * The current labels, cached for 30 s — every notification and tile render
 * reads them. The cache is per process: with several platform-api replicas an
 * alias edit reaches the others when their copy expires, within 30 s.
 */
export async function loadNodeLabels(db: Database): Promise<NodeLabels> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const res = await db.execute(sql`
    SELECT name, display_name, labels->>'kubernetes.io/hostname' AS hostname FROM cluster_nodes
  `) as unknown as { rows: Array<{ name: string; display_name: string | null; hostname: string | null }> };
  const value = buildNodeLabels((res.rows ?? []).map((r) => ({ name: r.name, displayName: r.display_name, hostname: r.hostname })));
  cache = { at: Date.now(), value };
  return value;
}

/** Forget this process's cache after an alias edit; other replicas catch up within the TTL. */
export function invalidateNodeLabels(): void {
  cache = null;
}
