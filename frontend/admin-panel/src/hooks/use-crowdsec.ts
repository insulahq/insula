/**
 * CrowdSec / Banned IPs admin hooks.
 *
 *   GET    /admin/security/crowdsec/decisions
 *   POST   /admin/security/crowdsec/decisions       — manual ban
 *   DELETE /admin/security/crowdsec/decisions/:id   — unban
 *   GET    /admin/security/crowdsec/status          — coverage + bouncers + capi
 *
 * Decisions are refetched every 15s — bouncer pulls happen every few seconds
 * so 15s is the longest a stale list can persist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CrowdsecAddAllowlistRequest,
  CrowdsecAddAllowlistResponse,
  CrowdsecAddBanRequest,
  CrowdsecAddBanResponse,
  CrowdsecAddStaticBanRequest,
  CrowdsecAutobanCalibrationResponse,
  CrowdsecAutobanConfig,
  CrowdsecAutobanListRunsResponse,
  CrowdsecAutobanPatchConfigRequest,
  CrowdsecConsoleEnrollRequest,
  CrowdsecConsoleMetaPatch,
  CrowdsecConsoleStatus,
  CrowdsecDeleteByIdResponse,
  CrowdsecL4Mode,
  CrowdsecL4PatchModeRequest,
  CrowdsecL4Status,
  CrowdsecListAllowlistResponse,
  CrowdsecListDecisionsQuery,
  CrowdsecListDecisionsResponse,
  CrowdsecRemoveAllowlistResponse,
  CrowdsecStatus,
  CrowdsecCommunityBlocklistStatus,
  CrowdsecCommunityBlocklistSetting,
} from '@insula/api-contracts';

interface Envelope<T> { readonly data: T; }

const DECISIONS_KEY = ['crowdsec', 'decisions'] as const;
const STATUS_KEY = ['crowdsec', 'status'] as const;
const COMMUNITY_KEY = ['crowdsec', 'community-blocklist'] as const;

/**
 * Build the query string from EVERY field of the query object.
 *
 * This used to forward only q / scope / manualOnly. `staticOnly` and
 * `autoOnly` were set by the filter checkboxes, dropped here, and therefore
 * never reached the backend — which supports both. The filters silently did
 * nothing, so an operator's static ban stayed buried among 16,220 community
 * decisions and the Static Blocklist read as empty when the ban was in fact
 * present in the LAPI. Derive the params from the object instead of listing
 * them by hand, so a new filter cannot be forgotten the same way.
 */
function decisionsQueryString(query: CrowdsecListDecisionsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function useCrowdsecDecisions(query: CrowdsecListDecisionsQuery) {
  const qs = decisionsQueryString(query);
  const url = qs
    ? `/api/v1/admin/security/crowdsec/decisions?${qs}`
    : '/api/v1/admin/security/crowdsec/decisions';
  return useQuery<Envelope<CrowdsecListDecisionsResponse>>({
    queryKey: [...DECISIONS_KEY, query],
    queryFn: () => apiFetch(url),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useCrowdsecStatus() {
  return useQuery<Envelope<CrowdsecStatus>>({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/status'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAddCrowdsecBan() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddBanResponse>, Error, CrowdsecAddBanRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/decisions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    },
  });
}

export function useDeleteCrowdsecDecision() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecDeleteByIdResponse>, Error, number>({
    mutationFn: (id) =>
      apiFetch(`/api/v1/admin/security/crowdsec/decisions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DECISIONS_KEY });
    },
  });
}

// ─── F2 — Allowlist + Static blocklist hooks ──────────────────────────

const ALLOWLIST_KEY = ['crowdsec', 'allowlist'] as const;

export function useCrowdsecAllowlist() {
  return useQuery<Envelope<CrowdsecListAllowlistResponse>>({
    queryKey: ALLOWLIST_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/allowlist'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAddCrowdsecAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddAllowlistResponse>, Error, CrowdsecAddAllowlistRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/allowlist', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    },
  });
}

export function useRemoveCrowdsecAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecRemoveAllowlistResponse>, Error, string>({
    mutationFn: (value) =>
      apiFetch(`/api/v1/admin/security/crowdsec/allowlist/${encodeURIComponent(value)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    },
  });
}

/** Community-blocklist (CAPI) opt-in state. */
export function useCrowdsecCommunityBlocklist() {
  return useQuery<Envelope<CrowdsecCommunityBlocklistStatus>>({
    queryKey: COMMUNITY_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/community-blocklist'),
    staleTime: 10_000,
  });
}

export function useSetCrowdsecCommunityBlocklist() {
  const qc = useQueryClient();
  return useMutation<Envelope<unknown>, Error, CrowdsecCommunityBlocklistSetting>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/community-blocklist', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: COMMUNITY_KEY });
      // The decision list changes too: disabling purges the community bans.
      void qc.invalidateQueries({ queryKey: DECISIONS_KEY });
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useAddCrowdsecStaticBan() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAddBanResponse>, Error, CrowdsecAddStaticBanRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/static-blocklist', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['crowdsec', 'decisions'] });
    },
  });
}

// ─── F5 — CrowdSec Console enrollment hooks ─────────────────────────

const CONSOLE_KEY = ['crowdsec', 'console'] as const;

export function useCrowdsecConsoleStatus() {
  return useQuery<Envelope<CrowdsecConsoleStatus>>({
    queryKey: CONSOLE_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/console'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useEnrollCrowdsecConsole() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecConsoleStatus>, Error, CrowdsecConsoleEnrollRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/console/enroll', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONSOLE_KEY });
    },
  });
}

export function useDisenrollCrowdsecConsole() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecConsoleStatus>, Error, void>({
    mutationFn: () =>
      apiFetch('/api/v1/admin/security/crowdsec/console/disenroll', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONSOLE_KEY });
    },
  });
}

export function usePatchCrowdsecConsoleMeta() {
  const qc = useQueryClient();
  return useMutation<Envelope<{ visible: boolean }>, Error, CrowdsecConsoleMetaPatch>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/console/meta', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONSOLE_KEY });
    },
  });
}

// ─── F3 — Auto-ban config + runs + calibration ───────────────────────

const AUTOBAN_CONFIG_KEY = ['crowdsec', 'autoban', 'config'] as const;
const AUTOBAN_RUNS_KEY = ['crowdsec', 'autoban', 'runs'] as const;

export function useCrowdsecAutobanConfig() {
  return useQuery<Envelope<CrowdsecAutobanConfig>>({
    queryKey: AUTOBAN_CONFIG_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/autoban/config'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function usePatchCrowdsecAutobanConfig() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecAutobanConfig>, Error, CrowdsecAutobanPatchConfigRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/autoban/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTOBAN_CONFIG_KEY });
    },
  });
}

export function useCrowdsecAutobanRuns(limit = 50) {
  return useQuery<Envelope<CrowdsecAutobanListRunsResponse>>({
    queryKey: [...AUTOBAN_RUNS_KEY, limit],
    queryFn: () => apiFetch(`/api/v1/admin/security/crowdsec/autoban/runs?limit=${limit}`),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useCalibrateAutoban() {
  // POST so the body can carry an override config; query param `hours`
  // (1..168) controls how far back to replay.
  return useMutation<
    Envelope<CrowdsecAutobanCalibrationResponse>,
    Error,
    { hours: number; override?: Partial<CrowdsecAutobanConfig> }
  >({
    mutationFn: ({ hours, override }) =>
      apiFetch(`/api/v1/admin/security/crowdsec/autoban/calibrate?hours=${hours}`, {
        method: 'POST',
        body: override ? JSON.stringify(override) : undefined,
      }),
  });
}

// ─── F1+F6 Stage C — L4 enforcement toggle hooks ────────────────────

const L4_KEY = ['crowdsec', 'l4'] as const;

export function useCrowdsecL4Status() {
  return useQuery<Envelope<CrowdsecL4Status>>({
    queryKey: L4_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/crowdsec/l4-enforcement'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function usePatchCrowdsecL4Mode() {
  const qc = useQueryClient();
  return useMutation<Envelope<CrowdsecL4Status>, Error, CrowdsecL4PatchModeRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/crowdsec/l4-enforcement', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: L4_KEY });
    },
  });
}

// ─── Stale-bouncer prune (manual button vs 24h scheduler) ────────────
//
// The button uses a 5-min default — matches the "online" definition in
// the status panel so "stale = the ones shown as stale" actually
// matches what gets pruned. The 24h scheduler stays conservative;
// this is opt-in cleanup.
export function usePruneCrowdsecBouncers(olderThanSeconds: number = 300) {
  const qc = useQueryClient();
  return useMutation<Envelope<{ message: string; pruned: number; olderThanSeconds: number }>, Error, void>({
    mutationFn: () =>
      apiFetch(`/api/v1/admin/security/crowdsec/bouncers/prune?olderThanSeconds=${olderThanSeconds}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
