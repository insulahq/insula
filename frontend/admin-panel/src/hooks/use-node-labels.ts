import { useCallback, useContext, useMemo } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { NodeLabel } from '@insula/api-contracts';

/**
 * What the admin panel calls each node: the operator's alias when one is set,
 * else the name the node arrived with (its Kubernetes name, or the hostname a
 * source reported). Every surface that shows a node goes through here — the
 * Kubernetes name of a node is whatever the host was called at install, and
 * the alias exists so nobody has to read `sv2.cluster.example.test`.
 *
 * Readable by every staff role (GET /admin/node-labels), unlike the node list.
 */
function isNodeLabel(v: unknown): v is NodeLabel {
  const r = v as Partial<NodeLabel> | null;
  return typeof r?.name === 'string' && typeof r.label === 'string'
    && (r.hostname === null || typeof r.hostname === 'string');
}

/** Never fetches — see `useNodeLabels`. */
const detachedClient = new QueryClient();

export function useNodeLabels() {
  // A node name renders in leaf components that also appear outside a query
  // provider (unit tests, isolated renders). There the name shows unaliased
  // instead of throwing: the query runs on a detached client and never fires.
  const client = useContext(QueryClientContext);
  return useQuery({
    queryKey: ['node-labels'],
    queryFn: async (): Promise<readonly NodeLabel[]> => {
      const body = await apiFetch<{ data?: unknown }>('/api/v1/admin/node-labels');
      // Every node name on every page passes through this — a malformed
      // answer must cost the aliases, never the page.
      return Array.isArray(body?.data) ? body.data.filter(isNodeLabel) : [];
    },
    staleTime: 60_000,
    enabled: client !== undefined,
  }, client ?? detachedClient);
}

/** name or hostname → alias, for nodes that have one. Pure. */
export function aliasMap(rows: readonly NodeLabel[]): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.label === r.name) continue; // no alias: keep whatever name the source used
    m.set(r.name, r.label);
    if (r.hostname && r.hostname !== r.name) m.set(r.hostname, r.label);
  }
  return m;
}

function useAliases(): ReadonlyMap<string, string> {
  const { data } = useNodeLabels();
  return useMemo(() => aliasMap(data ?? []), [data]);
}

/** `(name) => label` — the alias when set, else the name unchanged. */
export function useNodeLabel(): (name: string | null | undefined) => string {
  const aliases = useAliases();
  return useCallback((name) => (name ? aliases.get(name) ?? name : ''), [aliases]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every aliased node name inside free text — a probe's detail line, a reason
 * the server wrote — replaced by its alias. Whole names only: `sv1` is left
 * alone inside `sv10`, `pvc-sv1` or `sv1.other.test`; longest names first, so
 * an FQDN wins over its own short hostname. A `code span` is left alone: it is
 * something to type, and `kubectl` only knows the real name. Mirrors the
 * server's `aliasNodeNames` (backend/src/modules/nodes/labels.ts). Pure; the
 * pattern is built once per alias set.
 */
export function nodeTextAliaser(aliases: ReadonlyMap<string, string>): (text: string) => string {
  if (aliases.size === 0) return (text) => text;
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![A-Za-z0-9.-])(${names.map(escapeRegExp).join('|')})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'g');
  const swap = (part: string): string => part.replace(re, (m) => aliases.get(m) ?? m);
  return (text) => text.split(/(`[^`]*`)/).map((part, i) => (i % 2 === 1 ? part : swap(part))).join('');
}

/** `(text) => text` with every aliased node name replaced — see `nodeTextAliaser`. */
export function useNodeText(): (text: string | null | undefined) => string {
  const aliases = useAliases();
  const alias = useMemo(() => nodeTextAliaser(aliases), [aliases]);
  return useCallback((text) => (text ? alias(text) : ''), [alias]);
}
