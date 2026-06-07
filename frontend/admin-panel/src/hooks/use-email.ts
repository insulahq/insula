import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

// ─── Email Domains ───

interface EmailDomain {
  readonly id: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly domainName: string;
  readonly enabled: number;
  readonly dkimSelector: string;
  readonly dkimPublicKey: string | null;
  readonly maxMailboxes: number;
  readonly maxQuotaMb: number;
  readonly catchAllAddress: string | null;
  readonly mxProvisioned: number;
  readonly spfProvisioned: number;
  readonly dkimProvisioned: number;
  readonly dmarcProvisioned: number;
  readonly spamThresholdJunk: string;
  readonly spamThresholdReject: string;
  readonly mailboxCount?: number;
  readonly createdAt: string;
}

interface EmailDomainsResponse { readonly data: readonly EmailDomain[] }
interface EmailDomainResponse { readonly data: EmailDomain }

export function useAdminEmailDomains() {
  return useQuery({
    queryKey: ['admin-email-domains'],
    queryFn: () => apiFetch<EmailDomainsResponse>('/api/v1/admin/email/domains'),
  });
}

export function useEmailDomains(tenantId?: string) {
  return useQuery({
    queryKey: ['email-domains', tenantId],
    queryFn: () => apiFetch<EmailDomainsResponse>(`/api/v1/tenants/${tenantId}/email/domains`),
    enabled: !!tenantId,
  });
}

export function useEnableEmailDomain(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch<EmailDomainResponse>(`/api/v1/tenants/${tenantId}/email/domains/${domainId}/enable`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', tenantId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

export function useDisableEmailDomain(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/email/domains/${domainId}/disable`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', tenantId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

export function useUpdateEmailDomain(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domainId, input }: { domainId: string; input: Record<string, unknown> }) =>
      apiFetch<EmailDomainResponse>(`/api/v1/tenants/${tenantId}/email/domains/${domainId}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-domains', tenantId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

// ─── Mailboxes ───

interface Mailbox {
  readonly id: string;
  readonly emailDomainId: string;
  readonly tenantId: string;
  readonly localPart: string;
  readonly fullAddress: string;
  readonly displayName: string | null;
  readonly quotaMb: number;
  readonly usedMb: number;
  readonly status: string;
  readonly mailboxType: string;
  readonly autoReply: number;
  readonly autoReplySubject: string | null;
  readonly createdAt: string;
}

interface MailboxesResponse { readonly data: readonly Mailbox[] }
interface MailboxResponse { readonly data: Mailbox }

export function useMailboxes(tenantId?: string) {
  return useQuery({
    queryKey: ['mailboxes', tenantId],
    queryFn: () => apiFetch<MailboxesResponse>(`/api/v1/tenants/${tenantId}/mailboxes`),
    enabled: !!tenantId,
  });
}

export function useCreateMailbox(tenantId: string, emailDomainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<MailboxResponse>(`/api/v1/tenants/${tenantId}/email/domains/${emailDomainId}/mailboxes`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', tenantId] }),
  });
}

export function useUpdateMailbox(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
      apiFetch<MailboxResponse>(`/api/v1/tenants/${tenantId}/mailboxes/${id}`, {
        method: 'PATCH', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', tenantId] }),
  });
}

export function useDeleteMailbox(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/mailboxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mailboxes', tenantId] }),
  });
}

// ─── Email Aliases ───

interface EmailAlias {
  readonly id: string;
  readonly emailDomainId: string;
  readonly tenantId: string;
  readonly sourceAddress: string;
  readonly destinationAddresses: readonly string[];
  readonly enabled: number;
  readonly createdAt: string;
}

interface AliasesResponse { readonly data: readonly EmailAlias[] }
interface AliasResponse { readonly data: EmailAlias }

export function useEmailAliases(tenantId?: string) {
  return useQuery({
    queryKey: ['email-aliases', tenantId],
    queryFn: () => apiFetch<AliasesResponse>(`/api/v1/tenants/${tenantId}/email/aliases`),
    enabled: !!tenantId,
  });
}

export function useCreateEmailAlias(tenantId: string, emailDomainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<AliasResponse>(`/api/v1/tenants/${tenantId}/email/domains/${emailDomainId}/aliases`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', tenantId] }),
  });
}

export function useDeleteEmailAlias(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/email/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-aliases', tenantId] }),
  });
}

// ─── SMTP Relay ───

interface SmtpRelay {
  readonly id: string;
  readonly name: string;
  readonly providerType: string;
  readonly isDefault: number;
  readonly enabled: number;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly authUsername: string | null;
  readonly region: string | null;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: string | null;
  readonly createdAt: string;
}

interface RelaysResponse { readonly data: readonly SmtpRelay[] }
interface RelayResponse { readonly data: SmtpRelay }
interface TestResult { readonly data: { status: string; message?: string } }

export function useSmtpRelays() {
  return useQuery({
    queryKey: ['smtp-relays'],
    queryFn: () => apiFetch<RelaysResponse>('/api/v1/admin/email/smtp-relays'),
  });
}

export function useCreateSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<RelayResponse>('/api/v1/admin/email/smtp-relays', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

export function useDeleteSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/email/smtp-relays/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

export function useTestSmtpRelay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TestResult>(`/api/v1/admin/email/smtp-relays/${id}/test`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp-relays'] }),
  });
}

// ─── Webmail Token ───

interface WebmailTokenResponse { readonly data: { token: string; mailbox: string; webmailUrl: string } }

export function useWebmailToken() {
  return useMutation({
    mutationFn: (mailboxId: string) =>
      apiFetch<WebmailTokenResponse>('/api/v1/email/webmail-token', {
        method: 'POST', body: JSON.stringify({ mailbox_id: mailboxId }),
      }),
  });
}

interface AccessibleMailboxesResponse { readonly data: readonly Mailbox[] }

export function useAccessibleMailboxes() {
  return useQuery({
    queryKey: ['accessible-mailboxes'],
    queryFn: () => apiFetch<AccessibleMailboxesResponse>('/api/v1/email/accessible-mailboxes'),
  });
}

// ─── Phase 3 T1.1 — DKIM key rotation ───

export interface DkimKey {
  readonly id: string;
  readonly emailDomainId: string;
  readonly selector: string;
  readonly status: 'pending' | 'active' | 'retired';
  readonly dnsRecordValue: string;
  readonly dnsVerifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DkimKeysResponse { readonly data: readonly DkimKey[] }

export interface DkimRotateResult {
  /** 'dkim-1' | 'dkim-2' — selectors alternate on each rotation (A/B scheme). */
  readonly newSelector: string;
  /** Stays published + signing for in-flight mail; nothing to retire. Null on legacy domains. */
  readonly previousSelector: string | null;
  readonly newPublicKey: string;
  readonly txtRecordName: string;
  readonly txtRecordValue: string;
  readonly stalwartDkimSignatureId: string;
  readonly destroyedSelectors: readonly string[];
}

interface DkimRotateResponse { readonly data: DkimRotateResult }

export function useDkimKeys(tenantId?: string, domainId?: string) {
  return useQuery({
    queryKey: ['dkim-keys', tenantId, domainId],
    queryFn: () => apiFetch<DkimKeysResponse>(`/api/v1/tenants/${tenantId}/email/domains/${domainId}/dkim/keys`),
    enabled: !!tenantId && !!domainId,
  });
}

export function useRotateDkimKey(tenantId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      // Route lives at /email-domains/ (hyphenated) — the old
      // /email/domains/ rotate path was retired with M12/M13.
      apiFetch<DkimRotateResponse>(`/api/v1/tenants/${tenantId}/email-domains/${domainId}/dkim/rotate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dkim-keys', tenantId, domainId] });
      qc.invalidateQueries({ queryKey: ['admin-email-domains'] });
    },
  });
}

export function useActivateDkimKey(tenantId: string, domainId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiFetch<{ data: { id: string; status: string } }>(
        `/api/v1/tenants/${tenantId}/email/domains/${domainId}/dkim/keys/${keyId}/activate`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dkim-keys', tenantId, domainId] });
    },
  });
}

// ─── M12 — Read-only DKIM status via Stalwart JMAP ───

export interface DkimSelectorInfo {
  readonly name: string;
  readonly publicKey: string | null;
  readonly txtValue: string;
  readonly valid: boolean;
}

export interface DkimStatusData {
  readonly domainId: string;
  readonly domainName: string;
  readonly zoneFileAvailable: boolean;
  readonly selectors: readonly DkimSelectorInfo[];
  readonly rawLines: readonly string[];
}

interface DkimStatusResponse { readonly data: DkimStatusData }

export function useDkimStatus(emailDomainId?: string) {
  return useQuery({
    queryKey: ['dkim-status', emailDomainId],
    queryFn: () =>
      apiFetch<DkimStatusResponse>(`/api/v1/admin/email/domains/${emailDomainId}/dkim-status`),
    enabled: !!emailDomainId,
    staleTime: 30_000, // 30 s — zone file doesn't change that fast
  });
}

// ─── Phase 3 T5.1 — Mail submit credentials (sendmail compat) ───

export interface MailSubmitCredentialInfo {
  readonly exists: boolean;
  readonly id?: string;
  readonly username?: string;
  readonly createdAt?: string;
  readonly lastUsedAt?: string | null;
}

export interface MailSubmitRotateResult {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly pushedToPvc: boolean;
  readonly pushError?: string;
}

export function useMailSubmitCredential(tenantId?: string) {
  return useQuery({
    queryKey: ['mail-submit-credential', tenantId],
    queryFn: () =>
      apiFetch<{ data: MailSubmitCredentialInfo }>(`/api/v1/tenants/${tenantId}/mail/submit-credential`),
    enabled: !!tenantId,
  });
}

export function useRotateMailSubmitCredential(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { note?: string; pushToPvc?: boolean }) =>
      apiFetch<{ data: MailSubmitRotateResult }>(
        `/api/v1/tenants/${tenantId}/mail/submit-credential/rotate`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mail-submit-credential', tenantId] });
    },
  });
}

// ─── Phase 3 T2.1 — IMAPSync job runner ───

export type ImapSyncJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ImapSyncJob {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly sourceHost: string;
  readonly sourcePort: number;
  readonly sourceUsername: string;
  readonly sourceSsl: boolean;
  readonly options: Record<string, unknown>;
  readonly status: ImapSyncJobStatus;
  readonly k8sJobName: string | null;
  readonly k8sNamespace: string;
  readonly logTail: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateImapSyncJobInput {
  readonly mailbox_id: string;
  readonly source_host: string;
  readonly source_port: number;
  readonly source_username: string;
  readonly source_password: string;
  readonly source_ssl: boolean;
  readonly options?: {
    readonly automap?: boolean;
    readonly noFolderSizes?: boolean;
    readonly dryRun?: boolean;
    readonly excludeFolders?: readonly string[];
  };
}

export function useImapSyncJobs(tenantId?: string) {
  return useQuery({
    queryKey: ['imapsync-jobs', tenantId],
    queryFn: () =>
      apiFetch<{ data: readonly ImapSyncJob[] }>(`/api/v1/tenants/${tenantId}/mail/imapsync`),
    enabled: !!tenantId,
    // Poll while running so the UI shows progress without manual refresh.
    refetchInterval: (query) => {
      const data = query.state.data as { data?: readonly ImapSyncJob[] } | undefined;
      const hasRunning = data?.data?.some(
        (j) => j.status === 'running' || j.status === 'pending',
      );
      return hasRunning ? 5000 : false;
    },
  });
}

export function useCreateImapSyncJob(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateImapSyncJobInput) =>
      apiFetch<{ data: ImapSyncJob }>(`/api/v1/tenants/${tenantId}/mail/imapsync`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imapsync-jobs', tenantId] }),
  });
}

export function useCancelImapSyncJob(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch<{ data: { id: string; status: string } }>(
        `/api/v1/tenants/${tenantId}/mail/imapsync/${jobId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imapsync-jobs', tenantId] }),
  });
}
