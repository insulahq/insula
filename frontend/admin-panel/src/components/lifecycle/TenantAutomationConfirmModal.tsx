/**
 * Asks before automatic archive/delete reaches tenants: on a save that puts
 * tenants in front of the next run, and on "Run now" when it has something to
 * do. It names every tenant — those acted on at once, and those who are told
 * first and acted on at the date they are given, which nobody is asked about
 * again. A delete, at once or after its notice, also has to be typed.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import ErrorPanel from '@/components/ErrorPanel';
import ConfirmToken from '@/components/ui/ConfirmToken';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { daysSince, tenantCount, whyNotYet, type DatedCandidate, type NewlyDue } from '@/lib/tenant-automation';

interface Props {
  readonly kind: 'save' | 'run';
  readonly due: NewlyDue;
  readonly intervalHours: number;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export default function TenantAutomationConfirmModal({ kind, due, intervalHours, pending, error, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const { archive, remove } = due;
  const deletes = remove.now.length + remove.tell.length;
  const token = `delete ${tenantCount(deletes)}`;
  const needsToken = deletes > 0;
  const allowed = !pending && (!needsToken || typed.trim() === token);
  const when = kind === 'run' ? 'now' : `at the next run, within ${intervalHours} hours`;
  const nowMs = Date.now();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tenant-automation-confirm-title"
      data-testid="tenant-automation-confirm"
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 id="tenant-automation-confirm-title" className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={16} className={needsToken ? 'text-red-500' : 'text-amber-500'} />
            {kind === 'run' ? 'Run now?' : 'Save these settings?'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700"
            aria-label="Close"
            data-testid="tenant-automation-confirm-close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-4 text-sm text-gray-700 dark:text-gray-300">
          {archive.now.length > 0 && (
            <TenantList
              testId="tenant-automation-confirm-archive"
              heading={`${tenantCount(archive.now.length)} will be archived ${when}:`}
              tone="amber"
              tenants={archive.now}
              state="suspended"
              nowMs={nowMs}
            />
          )}
          {archive.tell.length > 0 && (
            <TenantList
              testId="tenant-automation-confirm-archive-tell"
              heading={`${tenantCount(archive.tell.length)} will be told ${when}, and archived on the date given:`}
              tone="amber"
              tenants={archive.tell}
              state="suspended"
              dated="archive"
              nowMs={nowMs}
            />
          )}
          {remove.now.length > 0 && (
            <TenantList
              testId="tenant-automation-confirm-delete"
              heading={`${tenantCount(remove.now.length)} will be deleted ${when}:`}
              tone="red"
              tenants={remove.now}
              state="archived"
              nowMs={nowMs}
            />
          )}
          {remove.tell.length > 0 && (
            <TenantList
              testId="tenant-automation-confirm-delete-tell"
              heading={`${tenantCount(remove.tell.length)} will be told ${when}, and deleted on the date given:`}
              tone="red"
              tenants={remove.tell}
              state="archived"
              dated="delete"
              nowMs={nowMs}
            />
          )}
          {archive.tell.length + remove.tell.length > 0 && (
            <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="tenant-automation-confirm-told-note">
              A tenant that has been told is archived or deleted on its date without another question. To stop that, keep it out
              or switch the step off before then.
            </p>
          )}
          {needsToken && (
            <label className="block space-y-1 text-xs">
              <span>
                A deleted tenant can only be recovered from its backups, and only while they are kept. Type{' '}
                <ConfirmToken value={token} className="text-red-700 dark:text-red-300" testId="tenant-automation-confirm-token" /> to go on.
              </span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={pending}
                autoComplete="off"
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                data-testid="tenant-automation-confirm-input"
              />
            </label>
          )}
          {error ? (
            <ErrorPanel error={extractOperatorError(error)} severity="error" compact testId="tenant-automation-confirm-error" />
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="tenant-automation-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!allowed}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
              needsToken ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'
            }`}
            data-testid="tenant-automation-confirm-ok"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {kind === 'run' ? 'Run now' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface TenantListProps {
  readonly testId: string;
  readonly heading: string;
  readonly tone: 'amber' | 'red';
  readonly tenants: readonly DatedCandidate[];
  readonly state: string;
  /** Name the date each tenant is acted on, with this verb. */
  readonly dated?: 'archive' | 'delete';
  readonly nowMs: number;
}

function TenantList({ testId, heading, tone, tenants, state, dated, nowMs }: TenantListProps) {
  const box = tone === 'red'
    ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-900/30 dark:text-red-100'
    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100';
  return (
    <div data-testid={testId}>
      <p className="font-medium text-gray-900 dark:text-gray-100">{heading}</p>
      <ul className={`mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded border p-2 text-xs ${box}`}>
        {tenants.map((t) => {
          const days = t.since ? daysSince(t.since, nowMs) : 0;
          const wait = whyNotYet(t.busy);
          return (
            <li key={t.tenantId}>
              <span className="font-medium">{t.name}</span> — {state} {days} day{days === 1 ? '' : 's'} ago
              {dated && <>, {dated} on {new Date(t.dueAt).toLocaleDateString()}</>}
              {wait && <span> ({wait})</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
