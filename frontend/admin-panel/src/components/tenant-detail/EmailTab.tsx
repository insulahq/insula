/**
 * Tenant → Email: how this tenant's mail is doing, and the admin's levers.
 *
 * The levers that are the operator's alone stay here: suspending outbound
 * mail and the send limits (edited on Plan & limits). Everything the tenant
 * manages — mailboxes, aliases, forwarding, mailing lists, migrations, DNS,
 * the DMARC/TLS/abuse report pages — is shown read-only and links into the
 * tenant panel at that item.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Tenant } from '@/types/api';
import { useUpdateTenant } from '@/hooks/use-tenants';
import { usePlans } from '@/hooks/use-plans';
import { useEmailDomains, useMailboxes, useEmailAliases, useImapSyncJobs, type ImapSyncJob } from '@/hooks/use-email';
import {
  useTenantAbuseReports, useTenantDmarc, useTenantMailDomainStats,
  useTenantMailUsage, useTenantSendLimitsLive, useTenantTlsReports,
} from '@/hooks/use-tenant-insights';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { Card, Chip, Meter, UsageTile, formatMb, type Tone } from './ui';
import TenantPanelLink from './TenantPanelLink';
import { tenantPanel } from './tenant-panel-paths';
import MailDailyChart from './MailDailyChart';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSortable, type SortAccessors } from '@/hooks/use-sortable';

type MailDomainRow = NonNullable<ReturnType<typeof useEmailDomains>['data']>['data'][number];
type MailboxRow = NonNullable<ReturnType<typeof useMailboxes>['data']>['data'][number];
type MailingListRow = NonNullable<ReturnType<typeof useEmailAliases>['data']>['data'][number];
type LiveSendLimits = NonNullable<ReturnType<typeof useTenantSendLimitsLive>['data']>['data']['domains'][number];

const HEAD = { padding: 'px-5 py-2.5', className: 'font-medium' } as const;
const HEAD_RIGHT = { padding: 'px-5 py-2.5', className: 'text-right font-medium' } as const;

export default function TenantEmailTab({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const { data: domainsRes, isLoading: domainsLoading } = useEmailDomains(tenantId);
  const domains = domainsRes?.data ?? [];

  if (!domainsLoading && domains.length === 0) {
    return (
      <Card testId="email-tab-empty">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-400">Email is not enabled on any of this tenant&rsquo;s domains.</p>
          <TenantPanelLink tenantId={tenantId} to={tenantPanel.email('settings')} label="Email → Settings & DNS" variant="button">Enable email on a domain</TenantPanelLink>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="email-tab">
      <OutboundCard tenant={tenant} tenantId={tenantId} />
      <UsageRow tenantId={tenantId} />
      <MailDailyChart tenantId={tenantId} />
      <DeliverabilityRow tenantId={tenantId} />
      <DomainsCard tenantId={tenantId} />
      <MailboxesCard tenantId={tenantId} />
      <MailingListsCard tenantId={tenantId} />
      <MigrationsCard tenantId={tenantId} />
    </div>
  );
}

function OutboundCard({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const qc = useQueryClient();
  const updateTenant = useUpdateTenant(tenantId);
  const { data: plansRes } = usePlans();
  const plan = plansRes?.data.find((p) => p.id === tenant.planId);
  const { data: liveRes, isLoading: liveLoading } = useTenantSendLimitsLive(tenantId);
  const live = liveRes?.data;
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const suspended = tenant.emailOutboundSuspended === true;
  const hourly = tenant.emailSendRateLimit ?? plan?.emailHourlySendLimit;
  const daily = tenant.emailSendRateLimitDaily ?? plan?.emailDailySendLimit;
  const custom = tenant.emailSendRateLimit != null || tenant.emailSendRateLimitDaily != null;
  const allInEffect = live?.reachable === true && live.domains.length > 0 && live.domains.every((d) => d.inEffect);
  const checked = live ? new Date(live.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const toggle = async () => {
    setErr(null);
    try {
      await updateTenant.mutateAsync({ email_outbound_suspended: !suspended });
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ['tenant-send-limits-live', tenantId] });
      await qc.invalidateQueries({ queryKey: ['tenant-mail-usage', tenantId] });
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Card testId="outbound-mail-section">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-[1_1_520px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Outbound sending</h2>
            {suspended ? <Chip tone="bad" dot>Suspended</Chip> : <Chip tone="ok" dot>Sending</Chip>}
            {custom && <Link to={`/tenants/${tenantId}/limits`}><Chip tone="warn">Custom limits</Chip></Link>}
          </div>
          <p className="mt-1.5 text-[13px] text-gray-700 dark:text-gray-300">
            {suspended
              ? 'Every outbound submission is refused. Receiving and webmail keep working.'
              : <>Limited to <strong>{hourly ?? '—'} per hour</strong> and <strong>{daily ?? '—'} per day</strong> per mail domain{plan && custom ? `; the ${plan.name} plan allows ${plan.emailHourlySendLimit} and ${plan.emailDailySendLimit}` : ''}.</>}
          </p>
          <p className="mt-1 text-[13px]" data-testid="send-limits-live">
            {liveLoading ? (
              <span className="inline-flex items-center gap-1.5 text-gray-500"><Loader2 size={12} className="animate-spin" /> Asking the mail server…</span>
            ) : !live ? null : !live.reachable ? (
              <span className="text-amber-700 dark:text-amber-400">The mail server could not be asked at {checked}; what it enforces is unknown.</span>
            ) : allInEffect ? (
              <span className="text-green-700 dark:text-green-400">The mail server holds exactly these limits (checked {checked}).</span>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">
                The mail server holds different limits for {live.domains.filter((d) => !d.inEffect).map((d) => d.domain).join(', ')} (checked {checked}). The next mail reconcile corrects it.
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/tenants/${tenantId}/limits`}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Edit limits
          </Link>
          {confirming ? (
            <>
              <button
                type="button"
                onClick={toggle}
                disabled={updateTenant.isPending}
                className={suspended
                  ? 'inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50'
                  : 'inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50'}
                data-testid="confirm-outbound-toggle"
              >
                {updateTenant.isPending && <Loader2 size={14} className="animate-spin" />}
                {suspended ? 'Confirm resume' : 'Confirm suspend'}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={suspended
                ? 'rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
                : 'rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20'}
              data-testid="toggle-outbound-suspend"
            >
              {suspended ? 'Resume sending' : 'Suspend sending'}
            </button>
          )}
        </div>
      </div>
      {err !== null && <div className="mt-3"><ErrorPanel error={extractOperatorError(err)} severity="error" /></div>}
    </Card>
  );
}

function UsageRow({ tenantId }: { readonly tenantId: string }) {
  const { data: usageRes } = useTenantMailUsage(tenantId);
  const usage = usageRes?.data?.day && usageRes.data.hour ? usageRes.data : undefined;
  const { data: statsRes } = useTenantMailDomainStats(tenantId);
  const stats = statsRes?.data.domains ?? [];
  const sent7d = stats.reduce((n, d) => n + d.sent7d, 0);
  const rcpt7d = stats.reduce((n, d) => n + d.recipients7d, 0);
  const limited7d = stats.reduce((n, d) => n + d.rateLimited7d, 0);
  const refused7d = stats.reduce((n, d) => n + d.quotaRejected7d, 0);
  const pct = (u?: { used: number; limit: number }) => (u && u.limit > 0 ? (u.used / u.limit) * 100 : null);
  const limits = `/tenants/${tenantId}/limits`;
  return (
    <section aria-label="Sending usage" className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-4">
      <UsageTile label="This hour" value={usage ? String(usage.hour.used) : '—'} of={usage ? `/ ${usage.hour.limit}` : undefined} pct={pct(usage?.hour)} note="Since the full hour, UTC" to={limits} testId="mail-hour" />
      <UsageTile label="Today" value={usage ? String(usage.day.used) : '—'} of={usage ? `/ ${usage.day.limit}` : undefined} pct={pct(usage?.day)} note={usage ? `Since 00:00 UTC · ${usage.day.recipients} recipients` : undefined} to={limits} testId="mail-day" />
      <UsageTile label="Last 7 days" value={String(sent7d)} of="messages" note={`${rcpt7d} recipients`} testId="mail-7d" />
      <UsageTile
        label="Held back, 7 days"
        value={String(limited7d + refused7d)}
        of="messages"
        note={`${limited7d} over the rate limit · ${refused7d} refused by the queue cap`}
        noteTone={limited7d + refused7d > 0 ? 'warn' : undefined}
        to="/monitoring/mail"
        testId="mail-held"
      />
    </section>
  );
}

function DeliverabilityRow({ tenantId }: { readonly tenantId: string }) {
  const { data: dmarcRes } = useTenantDmarc(tenantId);
  const { data: tlsRes } = useTenantTlsReports(tenantId);
  const { data: abuseRes } = useTenantAbuseReports(tenantId);
  const dmarc = dmarcRes?.data;
  const totals = (dmarc?.domains ?? []).reduce(
    (a, d) => ({ total: a.total + d.totalMessages, pass: a.pass + d.passMessages, failing: a.failing + d.failingSources }),
    { total: 0, pass: 0, failing: 0 },
  );
  const policies = [...new Set((dmarc?.domains ?? []).map((d) => d.currentPolicy).filter(Boolean))];
  const tls = tlsRes?.data;
  const abuse = abuseRes?.data;
  const tile = 'block px-5 py-4';
  return (
    <section aria-label="Deliverability" className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
      <TenantPanelLink tenantId={tenantId} to={tenantPanel.email('dmarc')} label="Email → Authentication" variant="tile" testId="tile-dmarc">
        <span className={tile}>
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">DMARC, {dmarc?.windowDays ?? 30} days</span>
            {policies.length > 0 && <Chip tone="ok">p={policies.join(' / ')}</Chip>}
          </span>
          <span className="mt-2 block text-2xl font-bold text-gray-900 dark:text-gray-100">
            {totals.total > 0 ? `${Math.round((totals.pass / totals.total) * 100)}%` : '—'}
            <span className="ml-1.5 text-[13px] font-normal text-gray-500 dark:text-gray-400">{totals.total > 0 ? `pass · ${totals.total.toLocaleString()} messages reported` : 'no reports yet'}</span>
          </span>
          <span className="mt-1.5 block text-[13px] text-gray-700 dark:text-gray-300">{totals.failing} failing {totals.failing === 1 ? 'source' : 'sources'}.</span>
        </span>
      </TenantPanelLink>
      <TenantPanelLink tenantId={tenantId} to={tenantPanel.email('tls')} label="Email → Delivery security" variant="tile" testId="tile-tls">
        <span className={tile}>
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">TLS reports, {tls?.windowDays ?? 30} days</span>
            {tls && tls.totalFailedSessions > 0 ? <Chip tone="warn">Failures</Chip> : tls && tls.total > 0 ? <Chip tone="ok">Healthy</Chip> : null}
          </span>
          <span className="mt-2 block text-2xl font-bold text-gray-900 dark:text-gray-100">
            {tls?.successRate != null ? `${Math.round(tls.successRate * 100)}%` : '—'}
            <span className="ml-1.5 text-[13px] font-normal text-gray-500 dark:text-gray-400">
              {tls ? `of ${(tls.totalSuccessfulSessions + tls.totalFailedSessions).toLocaleString()} sessions encrypted` : ''}
            </span>
          </span>
          <span className="mt-1.5 block text-[13px] text-gray-700 dark:text-gray-300">{tls ? `${tls.total} reports received.` : ''}</span>
        </span>
      </TenantPanelLink>
      <TenantPanelLink tenantId={tenantId} to={tenantPanel.email('abuse')} label="Email → Abuse reports" variant="tile" testId="tile-abuse">
        <span className={tile}>
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Abuse reports, {abuse?.windowDays ?? 30} days</span>
            {abuse && (abuse.total > 0 ? <Chip tone="bad">{abuse.total}</Chip> : <Chip>None</Chip>)}
          </span>
          <span className="mt-2 block text-2xl font-bold text-gray-900 dark:text-gray-100">
            {abuse ? abuse.total : '—'}
            <span className="ml-1.5 text-[13px] font-normal text-gray-500 dark:text-gray-400">complaints received</span>
          </span>
          <span className="mt-1.5 block text-[13px] text-gray-700 dark:text-gray-300">Feedback loops and abuse@ reports naming this tenant.</span>
        </span>
      </TenantPanelLink>
    </section>
  );
}

function dnsChips(d: { readonly mxProvisioned: number; readonly spfProvisioned: number; readonly dkimProvisioned: number; readonly dmarcProvisioned: number }) {
  const all: ReadonlyArray<readonly [string, number]> = [['MX', d.mxProvisioned], ['SPF', d.spfProvisioned], ['DKIM', d.dkimProvisioned], ['DMARC', d.dmarcProvisioned]];
  return (
    <span className="inline-flex flex-wrap gap-x-2.5 gap-y-1">
      {all.map(([k, v]) => (
        <span key={k} className={`text-xs font-medium ${v ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>{k} {v ? '✓' : '✕'}</span>
      ))}
    </span>
  );
}

/** What the "Send limits on the mail server" chip says. */
function sendLimitText(l: LiveSendLimits): string {
  if (l.inEffect) return l.desired.blocked ? 'Blocked, as wanted' : `${l.live.hourly}/h · ${l.live.daily}/day`;
  return l.live.hourly == null && l.live.daily == null && !l.live.blocked ? 'Missing' : `Holds ${l.live.hourly ?? '—'}/h · ${l.live.daily ?? '—'}/day`;
}

function DomainsCard({ tenantId }: { readonly tenantId: string }) {
  const { data: domainsRes } = useEmailDomains(tenantId);
  const { data: statsRes } = useTenantMailDomainStats(tenantId);
  const { data: liveRes } = useTenantSendLimitsLive(tenantId);
  const domains = domainsRes?.data ?? [];
  const stat = (name: string) => statsRes?.data.domains.find((s) => s.domain === name.toLowerCase());
  const live = (name: string) => liveRes?.data.domains.find((s) => s.domain === name.toLowerCase());
  // Live figures come from two other queries, so the accessors follow them.
  const accessors = useMemo<SortAccessors<MailDomainRow>>(() => {
    const statOf = (d: MailDomainRow) => statsRes?.data.domains.find((s) => s.domain === d.domainName.toLowerCase());
    return {
      status: (d) => (d.enabled ? 'Enabled' : 'Disabled'),
      dns: (d) => [d.mxProvisioned, d.spfProvisioned, d.dkimProvisioned, d.dmarcProvisioned].filter(Boolean).length,
      sendLimits: (d) => {
        const l = liveRes?.data.domains.find((s) => s.domain === d.domainName.toLowerCase());
        return l ? sendLimitText(l) : null;
      },
      sent24h: (d) => statOf(d)?.sent24h ?? 0,
      sent7d: (d) => statOf(d)?.sent7d ?? 0,
      held7d: (d) => (statOf(d)?.rateLimited7d ?? 0) + (statOf(d)?.quotaRejected7d ?? 0),
    };
  }, [statsRes, liveRes]);
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(domains, 'domainName', 'asc', accessors);
  const sort = { currentKey: sortKey, direction: sortDirection, onSort } as const;
  return (
    <Card
      title="Mail domains"
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.email('settings')} label="Email → Settings & DNS" variant="button">Enable email on a domain</TenantPanelLink>}
      bodyClassName="overflow-x-auto"
      testId="mail-domains"
    >
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <SortableHeader label="Domain" sortKey="domainName" {...HEAD} {...sort} />
            <SortableHeader label="Status" sortKey="status" {...HEAD} {...sort} />
            <SortableHeader label="DNS records" sortKey="dns" {...HEAD} {...sort} />
            <SortableHeader label="Send limits on the mail server" sortKey="sendLimits" {...HEAD} {...sort} />
            <SortableHeader label="Sent, 24 h" sortKey="sent24h" {...HEAD_RIGHT} {...sort} />
            <SortableHeader label="Sent, 7 days" sortKey="sent7d" {...HEAD_RIGHT} {...sort} />
            <SortableHeader label="Held back, 7 days" sortKey="held7d" {...HEAD_RIGHT} {...sort} />
            <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((d) => {
            const s = stat(d.domainName);
            const l = live(d.domainName);
            return (
              <tr key={d.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                <td className="px-5 py-3 font-medium text-gray-900 dark:text-gray-100">{d.domainName}</td>
                <td className="px-5 py-3">{d.enabled ? <Chip tone="ok" dot>Enabled</Chip> : <Chip>Disabled</Chip>}</td>
                <td className="px-5 py-3">{dnsChips(d)}</td>
                <td className="px-5 py-3">
                  {!l ? <span className="text-gray-400">—</span>
                    : l.inEffect
                      ? <Chip tone="ok">{sendLimitText(l)}</Chip>
                      : <Chip tone="warn" title={`Wanted ${l.desired.hourly}/h · ${l.desired.daily}/day${l.live.duplicates ? ` · ${l.live.duplicates} duplicate objects` : ''}`}>
                          {sendLimitText(l)}
                        </Chip>}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">{s?.sent24h ?? 0}</td>
                <td className="px-5 py-3 text-right tabular-nums">{s?.sent7d ?? 0}</td>
                <td className="px-5 py-3 text-right tabular-nums">{(s?.rateLimited7d ?? 0) + (s?.quotaRejected7d ?? 0)}</td>
                <td className="px-5 py-3 text-right">
                  <TenantPanelLink tenantId={tenantId} to={tenantPanel.email('settings', d.id)} label={`Email → Settings & DNS for ${d.domainName}`}>Settings &amp; DNS</TenantPanelLink>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

const listText = (items: readonly string[] | null | undefined): string | null => (items && items.length > 0 ? items.join(', ') : null);

const MAILBOX_SORT: SortAccessors<MailboxRow> = {
  storage: (m) => (m.mailboxType === 'send_only' ? null : m.usedMb),
  aliases: (m) => listText(m.aliases),
  forwards: (m) => listText(m.forwardingAddresses),
  autoReply: (m) => (m.autoReply ? (m.autoReplySubject ? `On: “${m.autoReplySubject}”` : 'On') : 'Off'),
};

const MAILING_LIST_SORT: SortAccessors<MailingListRow> = {
  deliversTo: (l) => listText(l.destinationAddresses),
  recipients: (l) => l.destinationAddresses.length,
  status: (l) => (l.enabled ? 'Enabled' : 'Disabled'),
};

function MailboxesCard({ tenantId }: { readonly tenantId: string }) {
  const { data: mailboxesRes, isLoading } = useMailboxes(tenantId);
  const mailboxes = mailboxesRes?.data ?? [];
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(mailboxes, 'fullAddress', 'asc', MAILBOX_SORT);
  const sort = { currentKey: sortKey, direction: sortDirection, onSort } as const;
  const usedMb = mailboxes.reduce((n, m) => n + (m.usedMb ?? 0), 0);
  const quotaMb = mailboxes.reduce((n, m) => n + (m.quotaMb ?? 0), 0);
  const aliasCount = mailboxes.reduce((n, m) => n + (m.aliases?.length ?? 0), 0);
  const forwards = mailboxes.filter((m) => (m.forwardingAddresses?.length ?? 0) > 0).length;
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Mailboxes</h2>
          <span className="text-[13px] text-gray-500 dark:text-gray-400">{mailboxes.length} mailboxes · {formatMb(usedMb)} of {formatMb(quotaMb)} used · {aliasCount} aliases · {forwards} forwarding</span>
        </div>
      )}
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.email('mailboxes')} label="Email → Mailboxes" variant="button">Add mailbox</TenantPanelLink>}
      bodyClassName="overflow-x-auto"
      testId="mailboxes-card"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : mailboxes.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No mailboxes yet.</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <SortableHeader label="Address" sortKey="fullAddress" {...HEAD} {...sort} />
              <SortableHeader label="Storage" sortKey="storage" padding={HEAD.padding} className="min-w-[180px] font-medium" {...sort} />
              <SortableHeader label="Aliases (also delivered here)" sortKey="aliases" {...HEAD} {...sort} />
              <SortableHeader label="Forwards to" sortKey="forwards" {...HEAD} {...sort} />
              <SortableHeader label="Auto-reply" sortKey="autoReply" {...HEAD} {...sort} />
              <SortableHeader label="Status" sortKey="status" {...HEAD} {...sort} />
              <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((m) => {
              const sendOnly = m.mailboxType === 'send_only';
              const pct = m.quotaMb > 0 ? (m.usedMb / m.quotaMb) * 100 : null;
              return (
                <tr key={m.id} className="border-b border-gray-100 align-top last:border-0 dark:border-gray-700" data-testid={`mailbox-${m.id}`}>
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{m.fullAddress}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{[m.displayName, sendOnly ? 'send-only' : 'mailbox'].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-5 py-3">
                    {sendOnly ? <span className="text-gray-500 dark:text-gray-400">Stores nothing</span> : (
                      <div className="flex items-center gap-2.5">
                        <div className="min-w-[70px] flex-1"><Meter pct={pct} /></div>
                        <span className="whitespace-nowrap text-xs tabular-nums text-gray-700 dark:text-gray-300">{formatMb(m.usedMb)} of {formatMb(m.quotaMb)}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {(m.aliases?.length ?? 0) === 0 ? <span className="text-gray-500 dark:text-gray-400">None</span> : (
                      <span className="flex flex-wrap gap-1">
                        {m.aliases!.map((a) => <span key={a} className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">{a}</span>)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {(m.forwardingAddresses?.length ?? 0) === 0
                      ? <span className="text-gray-500 dark:text-gray-400">{sendOnly ? 'None; incoming mail is bounced' : 'None'}</span>
                      : <span className="flex flex-col gap-0.5 text-gray-900 dark:text-gray-100">{m.forwardingAddresses!.map((f) => <span key={f} className="break-all">{f}</span>)}</span>}
                  </td>
                  <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{m.autoReply ? (m.autoReplySubject ? `On: “${m.autoReplySubject}”` : 'On') : <span className="text-gray-500 dark:text-gray-400">Off</span>}</td>
                  <td className="px-5 py-3"><Chip tone={m.status === 'active' ? 'ok' : 'warn'} dot>{m.status}</Chip></td>
                  <td className="px-5 py-3 text-right">
                    <TenantPanelLink tenantId={tenantId} to={tenantPanel.mailbox(m.emailDomainId, m.id)} label={`Email → Mailboxes → ${m.fullAddress}`} testId={`tp-mailbox-${m.id}`}>Manage</TenantPanelLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MailingListsCard({ tenantId }: { readonly tenantId: string }) {
  const { data: aliasesRes, isLoading } = useEmailAliases(tenantId);
  const lists = aliasesRes?.data ?? [];
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(lists, 'sourceAddress', 'asc', MAILING_LIST_SORT);
  const sort = { currentKey: sortKey, direction: sortDirection, onSort } as const;
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Mailing lists</h2>
          <span className="text-[13px] text-gray-500 dark:text-gray-400">One address that delivers to several recipients</span>
        </div>
      )}
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.email('aliases')} label="Email → Mailing lists" variant="button">New mailing list</TenantPanelLink>}
      bodyClassName="overflow-x-auto"
      testId="mailing-lists-card"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : lists.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No mailing lists.</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <SortableHeader label="List address" sortKey="sourceAddress" {...HEAD} {...sort} />
              <SortableHeader label="Delivers to" sortKey="deliversTo" {...HEAD} {...sort} />
              <SortableHeader label="Recipients" sortKey="recipients" {...HEAD_RIGHT} {...sort} />
              <SortableHeader label="Status" sortKey="status" {...HEAD} {...sort} />
              <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((l) => (
              <tr key={l.id} className="border-b border-gray-100 align-top last:border-0 dark:border-gray-700" data-testid={`mailing-list-${l.id}`}>
                <td className="px-5 py-3 font-medium text-gray-900 dark:text-gray-100">{l.sourceAddress}</td>
                <td className="px-5 py-3">
                  <span className="flex flex-wrap gap-1">
                    {l.destinationAddresses.map((a) => <span key={a} className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">{a}</span>)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right tabular-nums">{l.destinationAddresses.length}</td>
                <td className="px-5 py-3">{l.enabled ? <Chip tone="ok" dot>Enabled</Chip> : <Chip>Disabled</Chip>}</td>
                <td className="px-5 py-3 text-right">
                  <TenantPanelLink tenantId={tenantId} to={tenantPanel.mailingList(l.emailDomainId, l.id)} label={`Email → Mailing lists → ${l.sourceAddress}`} testId={`tp-list-${l.id}`}>Manage</TenantPanelLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const JOB_TONE: Record<ImapSyncJob['status'], Tone> = { pending: 'info', running: 'info', succeeded: 'ok', failed: 'bad', cancelled: 'neutral' };
const JOB_LABEL: Record<ImapSyncJob['status'], string> = { pending: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

function MigrationsCard({ tenantId }: { readonly tenantId: string }) {
  const { data: jobsRes, isLoading } = useImapSyncJobs(tenantId);
  const { data: mailboxesRes } = useMailboxes(tenantId);
  const jobs = jobsRes?.data ?? [];
  const domainOf = (mailboxId: string) => mailboxesRes?.data.find((m) => m.id === mailboxId)?.emailDomainId;
  const active = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Mail migrations (IMAP)</h2>
          <span className="text-[13px] text-gray-500 dark:text-gray-400">{jobs.length} of 10 jobs · {active} of 3 running</span>
        </div>
      )}
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.email('mailboxes')} label="Email → Mailboxes → Migrate from external IMAP" variant="button">New migration</TenantPanelLink>}
      bodyClassName=""
      testId="migrations-card"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : jobs.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No migrations.</p>
      ) : (
        <ul>
          {jobs.map((j) => {
            const running = j.status === 'pending' || j.status === 'running';
            const done = j.messagesTransferred ?? null;
            const total = j.messagesTotal ?? null;
            const pct = done != null && total != null && total > 0 ? (done / total) * 100 : null;
            const emailDomainId = domainOf(j.mailboxId);
            const at = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');
            return (
              <li key={j.id} className="border-b border-gray-100 px-5 py-3.5 last:border-0 dark:border-gray-700" data-testid={`migration-${j.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <span className="font-mono text-[13px] text-gray-900 dark:text-gray-100">
                      {j.sourceUsername}@{j.sourceHost}
                      <span className="mx-1.5 text-gray-400" aria-label="into">→</span>
                      {j.mailboxAddress ?? '(mailbox removed)'}
                    </span>
                    <Chip tone={JOB_TONE[j.status]} dot>{JOB_LABEL[j.status]}</Chip>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[13px]">
                    {running ? (
                      <TenantPanelLink tenantId={tenantId} to={tenantPanel.migration(j.id, undefined, emailDomainId)} label="this migration (cancel it there)" variant="danger" testId={`tp-migration-cancel-${j.id}`}>Cancel</TenantPanelLink>
                    ) : (
                      <>
                        <TenantPanelLink tenantId={tenantId} to={tenantPanel.migration(j.id, 'edit', emailDomainId)} label="this migration's edit form" testId={`tp-migration-edit-${j.id}`}>Edit</TenantPanelLink>
                        <TenantPanelLink tenantId={tenantId} to={tenantPanel.migration(j.id, undefined, emailDomainId)} label="this migration (re-sync it there)" testId={`tp-migration-resync-${j.id}`}>Re-sync</TenantPanelLink>
                        <TenantPanelLink tenantId={tenantId} to={tenantPanel.migration(j.id, undefined, emailDomainId)} label="this migration (delete it there)" variant="danger" testId={`tp-migration-delete-${j.id}`}>Delete</TenantPanelLink>
                      </>
                    )}
                  </div>
                </div>
                {running && (
                  <div className="mt-2.5 flex max-w-xl items-center gap-3">
                    <div className="flex-1"><Meter pct={pct ?? 0} /></div>
                    <span className="text-xs tabular-nums text-gray-700 dark:text-gray-300">{done != null && total != null ? `${done.toLocaleString()} of ${total.toLocaleString()} messages` : 'Counting messages…'}</span>
                  </div>
                )}
                {j.status === 'failed' && j.errorMessage && <p className="mt-1.5 text-[13px] text-red-700 dark:text-red-400">{j.errorMessage}</p>}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Started {at(j.startedAt ?? j.createdAt)}{j.finishedAt ? ` · finished ${at(j.finishedAt)}` : ''}
                  {!running && done != null ? ` · ${done.toLocaleString()}${total != null ? ` of ${total.toLocaleString()}` : ''} messages` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
