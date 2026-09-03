import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, API_BASE } from '@/lib/api-client';
import type {
  CertToken,
  CertDownloadAvailability,
  CreateCertTokenInput,
  CreateCertTokenResponse,
} from '@insula/api-contracts';

// Types come from @insula/api-contracts, never re-declared here — a
// hand-written interface is self-consistent, so TypeScript cannot catch a
// field the server does not actually send.
export type { CertToken, CertDownloadAvailability, CreateCertTokenResponse };

function base(tenantId: string, domainId: string): string {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}`;
}

/**
 * Whether this domain has anything to download, so the button can be disabled
 * with a reason instead of firing a request that 404s.
 */
export function useCertDownloadAvailability(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['cert-download-availability', tenantId, domainId],
    queryFn: () => apiFetch<{ data: CertDownloadAvailability }>(
      `${base(tenantId!, domainId!)}/ssl-cert/download-availability`,
    ),
    enabled: Boolean(tenantId && domainId),
  });
}

export function useCertTokens(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['cert-tokens', tenantId, domainId],
    queryFn: () => apiFetch<{ data: CertToken[] }>(`${base(tenantId!, domainId!)}/cert-tokens`),
    enabled: Boolean(tenantId && domainId),
  });
}

export function useCreateCertToken(tenantId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCertTokenInput) =>
      apiFetch<{ data: CreateCertTokenResponse }>(`${base(tenantId, domainId)}/cert-tokens`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cert-tokens', tenantId, domainId] }),
  });
}

export function useRevokeCertToken(tenantId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiFetch<void>(`${base(tenantId, domainId)}/cert-tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cert-tokens', tenantId, domainId] }),
  });
}

/**
 * Fetch the PEM and hand it to the browser as a file.
 *
 * Plain `fetch` rather than `apiFetch`: the response is a PEM body, not the
 * JSON envelope, and a `window.location` navigation cannot carry the Bearer
 * header. Mirrors the mTLS certificate download.
 *
 * Throws on failure so the caller can surface it — a download button that
 * silently does nothing is the worst possible outcome here.
 */
export async function downloadCertBundle(
  tenantId: string,
  domainId: string,
  domainName: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}${base(tenantId, domainId)}/ssl-cert/download`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}` },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch { /* non-JSON error body — keep the status */ }
    throw new Error(detail);
  }
  const pem = await res.text();
  const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-pem-file' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${domainName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'certificate'}.pem`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Always release the object URL — the blob holds a private key in memory.
    URL.revokeObjectURL(url);
  }
}
