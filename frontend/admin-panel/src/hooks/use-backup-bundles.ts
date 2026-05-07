import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  BundleDetail,
  CreateBundleInput,
  VerifyBundleResponse,
} from '@k8s-hosting/api-contracts';

/**
 * apiFetch returns raw wire JSON (no envelope unwrap), and the
 * routes wrap their payload with `success(...)` which adds an outer
 * `{ data: ... }`. So a list response on the wire is
 * `{ data: { data: BundleSummary[], pagination: {...} } }`.
 * Mirroring the convention in use-backup-config.ts.
 */
interface ListResponse {
  data: {
    data: BundleSummary[];
    pagination: { total_count: number; cursor: string | null; has_more: boolean; page_size: number };
  };
}

interface SingleResponse<T> { data: T }

/**
 * List bundles. Optionally filter by clientId. Refetches every 30s
 * so a freshly-created bundle shows up without manual refresh.
 */
export function useBundles(clientId?: string) {
  const path = clientId
    ? `/api/v1/admin/tenant-bundles?clientId=${encodeURIComponent(clientId)}`
    : '/api/v1/admin/tenant-bundles';
  return useQuery({
    queryKey: ['backup-bundles', clientId ?? 'all'],
    queryFn: () => apiFetch<ListResponse>(path),
    refetchInterval: 30_000,
  });
}

export function useBundleDetail(bundleId: string | null) {
  return useQuery({
    queryKey: ['backup-bundle', bundleId],
    queryFn: () => apiFetch<SingleResponse<BundleDetail>>(`/api/v1/admin/tenant-bundles/${bundleId}`),
    enabled: !!bundleId,
  });
}

export function useCreateBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBundleInput) =>
      apiFetch<SingleResponse<{ bundleId: string; status: string }>>('/api/v1/admin/tenant-bundles', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
    },
  });
}

/**
 * Trigger a browser download of the encrypted GDPR data-export
 * tarball. Uses fetch + Blob + URL.createObjectURL because <a
 * href> cannot carry the Authorization Bearer header. The blob
 * stays opaque ciphertext — the client decrypts locally with their
 * passphrase.
 */
export async function downloadDataExport(bundleId: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const r = await fetch(`/api/v1/admin/tenant-bundles/${bundleId}/data-export`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`download failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-export-${bundleId}.tar.gz.enc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Hold onto the blob URL just long enough for the click to take
  // effect, then revoke. Some browsers cancel the download if the
  // URL is revoked synchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Multi-region export download — POSTs the operator-supplied
 * passphrase + streams the encrypted tarball to disk. Different from
 * `downloadDataExport` (which downloads a pre-built artifact created
 * at capture time): this works on ANY bundle, generates the envelope
 * on-demand, and never requires the bundle to have been captured with
 * exportMode='data_export'. The downloaded file is decryptable with
 * stock openssl in the target region.
 */
export async function downloadBundleExport(bundleId: string, passphrase: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const r = await fetch(`/api/v1/admin/tenant-bundles/${bundleId}/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ passphrase }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`export failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bundle-${bundleId}.tar.gz.enc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ImportBundleResult {
  readonly bundleId: string;
  readonly sizeBytes: number;
  readonly componentCount: number;
}

/**
 * Multi-region import — multipart POST with the encrypted tarball
 * + passphrase + target clientId/targetConfigId. Server decrypts,
 * uploads each component to the local off-site target, registers a
 * fresh backup_jobs row.
 */
export async function importBundle(args: {
  file: File;
  passphrase: string;
  clientId: string;
  targetConfigId: string;
}): Promise<ImportBundleResult> {
  const fd = new FormData();
  fd.append('bundle', args.file);
  fd.append('passphrase', args.passphrase);
  fd.append('clientId', args.clientId);
  fd.append('targetConfigId', args.targetConfigId);
  const token = localStorage.getItem('auth_token');
  const r = await fetch('/api/v1/admin/tenant-bundles/import', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`import failed (${r.status}): ${detail.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.data as ImportBundleResult;
}

export interface VerifyAllResult {
  readonly summary: { readonly total: number; readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly results: ReadonlyArray<{
    readonly bundleId: string;
    readonly status: 'passed' | 'failed' | 'skipped';
    readonly reason?: string;
    readonly durationMs: number;
  }>;
}

/**
 * Batch-verify every bundle. Single-shot mutation; auto-invalidates
 * the bundles list so the UI re-fetches.
 */
export function useVerifyAllBundles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ data: VerifyAllResult }>('/api/v1/admin/tenant-bundles/verify-all', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    onSuccess: () => {
      // Invalidate both list (status display) and any open detail
      // panels so a verify-all run reflects in the UI immediately.
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
      qc.invalidateQueries({ queryKey: ['backup-bundle'] });
    },
  });
}

interface CoverageEnvelope { readonly data: import('@k8s-hosting/api-contracts').BundleCoverageResponse }

/**
 * Bundle coverage report — declared component registry + runtime
 * drift against the live DB schema. Powers the Coverage tab on the
 * Tenant Backup admin page.
 */
export function useBundleCoverage() {
  return useQuery({
    queryKey: ['tenant-bundles', 'coverage'],
    queryFn: () => apiFetch<CoverageEnvelope>('/api/v1/admin/tenant-bundles/coverage'),
    staleTime: 60_000,
  });
}

export function useDeleteBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<void>(`/api/v1/admin/tenant-bundles/${bundleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-bundles'] });
      // Also invalidate any open detail panels (different key prefix);
      // see use-backup-bundles.ts useBundleDetail.
      qc.invalidateQueries({ queryKey: ['backup-bundle'] });
    },
  });
}

/**
 * Run the round-trip integrity check for a bundle. The endpoint reads
 * every component back from the off-site target, decrypts + parses
 * each, and returns per-component sizes / SHA-256 / row counts.
 * No DB writes — safe to run repeatedly.
 */
export function useVerifyBundle() {
  return useMutation({
    mutationFn: (bundleId: string) =>
      apiFetch<SingleResponse<VerifyBundleResponse>>(`/api/v1/admin/tenant-bundles/${bundleId}/verify`, {
        method: 'POST',
      }),
  });
}
