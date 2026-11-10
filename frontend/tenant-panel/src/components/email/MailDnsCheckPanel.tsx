/**
 * The live-zone check under the Settings & DNS tab's records, and "Re-create
 * mail records".
 *
 * The records table says what the platform publishes. This says whether the
 * zone actually holds it — and, more often the problem, what ELSE the zone
 * holds at the same names: a domain moved in from another provider keeps its
 * old MX, SPF and DMARC records, and two SPF or DMARC records break both.
 *
 * Only where the platform hosts the zone. Elsewhere the banner above already
 * tells the owner to publish the records at their DNS provider.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import type { MailDnsCheck, MailDnsRecordStatus } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useEmailDomainDnsCheck, useRepairEmailDomainDns } from '@/hooks/use-email';

interface MailDnsCheckPanelProps {
  readonly tenantId: string;
  readonly domainId: string;
  readonly domainName: string;
}

/** The status the check gave one row of the records table, matched on type, name and purpose. */
export function mailRecordStatus(
  check: MailDnsCheck | undefined,
  record: { readonly type: string; readonly name: string; readonly purpose?: string },
): MailDnsRecordStatus | null {
  if (!check?.checked) return null;
  const hit = check.records.find((r) => r.type === record.type && r.name === record.name && r.purpose === record.purpose);
  return hit?.status ?? null;
}

const STATUS_PILL: Record<MailDnsRecordStatus, { readonly label: string; readonly title: string; readonly cls: string }> = {
  ok: {
    label: 'Published',
    title: 'The zone holds this record.',
    cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  },
  missing: {
    label: 'Missing',
    title: 'The zone does not hold this record. Re-create mail records publishes it.',
    cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  },
  replaced: {
    label: 'Your own',
    title: 'The domain publishes its own record of this kind, which stands in for this one.',
    cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  },
};

export function MailRecordStatusPill({ status }: { readonly status: MailDnsRecordStatus }) {
  const s = STATUS_PILL[status];
  return (
    <span className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.cls}`} title={s.title} data-testid={`mail-record-status-${status}`}>
      {s.label}
    </span>
  );
}

const refKey = (r: { readonly type: string; readonly name: string; readonly value: string }): string =>
  `${r.type}|${r.name}|${r.value}`;

function RecordLine({ type, name, value }: { readonly type: string; readonly name: string; readonly value: string }) {
  return (
    <span className="block min-w-0">
      <span className="font-mono font-semibold">{type}</span>{' '}
      <span className="font-mono break-all">{name}</span>{' '}
      <code className="font-mono break-all opacity-90">{value}</code>
    </span>
  );
}

export default function MailDnsCheckPanel({ tenantId, domainId, domainName }: MailDnsCheckPanelProps) {
  const q = useEmailDomainDnsCheck(tenantId, domainId);
  const repair = useRepairEmailDomainDns(tenantId, domainId);
  const [confirming, setConfirming] = useState(false);
  // Records the tenant unticked: another MX or SRV target kept on purpose.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const check = q.data?.data;

  if (q.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="mail-dns-checking">
        <Loader2 size={12} className="animate-spin" /> Checking this domain&apos;s DNS…
      </p>
    );
  }
  if (q.isError) {
    return <ErrorPanel error={extractOperatorError(q.error)} compact testId="mail-dns-check-error" />;
  }
  if (!check) return null;
  if (!check.checked) {
    if (check.reason === 'zone_unlisted') {
      return (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="mail-dns-unlisted">
          This domain&apos;s DNS server cannot list its records, so they are not checked against the zone.
        </p>
      );
    }
    if (check.reason !== 'zone_unreadable') return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200" data-testid="mail-dns-unreadable">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="flex-1">The DNS server did not answer, so these records were not checked against the zone.</span>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="rounded-md border border-amber-300 px-2 py-1 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
        >
          Check again
        </button>
      </div>
    );
  }

  const missing = check.records.filter((r) => r.status === 'missing').length;
  const hasErrors = check.issues.some((i) => i.severity === 'error');
  const nothingToDo = check.repair.add.length === 0 && check.repair.remove.length === 0 && check.repair.storedFixes === 0;
  const result = repair.data?.data;

  return (
    <div className="space-y-3" data-testid="mail-dns-check">
      {check.issues.length > 0 && (
        <div
          className={hasErrors
            ? 'rounded-lg border border-red-200 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-100'
            : 'rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100'}
          data-testid="mail-dns-issues"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle size={15} className="shrink-0" />
            {hasErrors
              ? `${domainName} has DNS records that break its mail`
              : `${domainName} has DNS records to review`}
          </p>
          <p className="mt-1 text-xs opacity-90">
            These records are in the domain&apos;s zone but were not written by the platform.
          </p>
          <ul className="mt-3 space-y-2.5 text-xs">
            {check.issues.map((i) => (
              <li key={`${i.kind}-${i.type}-${i.name}-${i.value}`} className="space-y-0.5" data-testid={`mail-dns-issue-${i.kind}`}>
                <RecordLine type={i.type} name={i.name} value={i.value} />
                <span className="block">{i.message}</span>
                {i.removable && (
                  <span className="block font-medium">Re-create mail records removes it.</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {missing > 0 && (
        <p className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300" data-testid="mail-dns-missing">
          <AlertTriangle size={14} className="shrink-0" />
          {missing === 1
            ? '1 of the platform’s mail records is missing from DNS (marked below).'
            : `${missing} of the platform’s mail records are missing from DNS (marked below).`}
        </p>
      )}
      {check.issues.length === 0 && missing === 0 && (
        <p className="flex items-center gap-2 text-xs text-green-700 dark:text-green-300" data-testid="mail-dns-ok">
          <CheckCircle size={13} className="shrink-0" /> Checked against the live zone: every mail record is published.
        </p>
      )}

      {confirming ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100" data-testid="mail-dns-repair-confirm">
          {nothingToDo ? (
            <p>Every mail record of {domainName} is in place; there is nothing to re-create.</p>
          ) : (
            <>
              <p className="font-medium">Re-create the mail records of {domainName}? This changes its DNS:</p>
              {check.repair.add.length > 0 && (
                <div className="mt-2 text-xs" data-testid="mail-dns-repair-add">
                  <p className="font-semibold">Publish</p>
                  <ul className="mt-1 space-y-1">
                    {check.repair.add.map((r) => (
                      <li key={`add-${r.type}-${r.name}-${r.value}`}>
                        <RecordLine type={r.type} name={r.name} value={r.priority !== null && r.type === 'MX' ? `${r.priority} ${r.value}` : r.value} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {check.repair.remove.length > 0 && (
                <div className="mt-2 text-xs" data-testid="mail-dns-repair-remove">
                  <p className="font-semibold">Remove</p>
                  <ul className="mt-1 space-y-1">
                    {check.repair.remove.map((r) => {
                      const key = refKey(r);
                      return (
                        <li key={`remove-${key}`} className="flex items-start gap-2">
                          {r.optional && (
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={!kept.has(key)}
                              onChange={(e) => setKept((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.delete(key); else next.add(key);
                                return next;
                              })}
                              aria-label={`Remove ${r.type} ${r.name} ${r.value}`}
                              data-testid={`mail-dns-repair-remove-toggle-${r.type}-${r.value}`}
                            />
                          )}
                          <RecordLine type={r.type} name={r.name} value={r.value} />
                        </li>
                      );
                    })}
                  </ul>
                  {check.repair.remove.some((r) => r.optional) && (
                    <p className="mt-1 opacity-90">
                      Untick another MX or SRV target you use on purpose — a backup mail server, a filtering service.
                    </p>
                  )}
                </div>
              )}
              {check.repair.storedFixes > 0 && (
                <p className="mt-2 text-xs opacity-90">
                  The platform&apos;s list of records is also brought in line with the zone
                  ({check.repair.storedFixes} {check.repair.storedFixes === 1 ? 'entry' : 'entries'}); that part changes nothing in DNS.
                </p>
              )}
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {!nothingToDo && (
              <button
                type="button"
                onClick={() => repair.mutate(
                  { keep: check.repair.remove.filter((r) => r.optional && kept.has(refKey(r))).map(({ type, name, value }) => ({ type, name, value })) },
                  { onSuccess: () => setConfirming(false) },
                )}
                disabled={repair.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="mail-dns-repair-confirm-button"
              >
                {repair.isPending && <Loader2 size={12} className="animate-spin" />} Re-create mail records
              </button>
            )}
            <button
              type="button"
              onClick={() => { setConfirming(false); repair.reset(); }}
              disabled={repair.isPending}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50"
              data-testid="mail-dns-repair-cancel"
            >
              {nothingToDo ? 'Close' : 'Cancel'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => { repair.reset(); setKept(new Set()); setConfirming(true); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            data-testid="mail-dns-repair-button"
            title="Publish the platform's mail records that are missing from DNS, and remove the records that get in their way"
          >
            <RefreshCw size={14} /> Re-create mail records
          </button>
        </div>
      )}

      {repair.error && (
        <ErrorPanel error={extractOperatorError(repair.error)} compact testId="mail-dns-repair-error" />
      )}
      {result && (
        <div className="space-y-1 text-xs" data-testid="mail-dns-repair-result">
          <p className="text-green-700 dark:text-green-300">
            Published {result.added} {result.added === 1 ? 'record' : 'records'}, removed {result.removed}
            {result.kept > 0 ? `, kept ${result.kept} you chose to keep` : ''}.
          </p>
          {result.failures.map((f) => (
            <p key={`${f.action}-${f.type}-${f.name}-${f.value}`} className="text-red-700 dark:text-red-300" data-testid="mail-dns-repair-failure">
              Could not {f.action} {f.type} {f.name}: {f.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
