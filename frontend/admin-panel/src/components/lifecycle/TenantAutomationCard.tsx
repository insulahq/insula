/**
 * Automatic archive and delete — the card at the top of Platform → Tenant
 * Lifecycle Hooks.
 *
 * Two switches, each with a limit in days, and a notice period. Under each
 * switch, the tenants it reaches: who is acted on at the next run, who is told
 * at the next run and acted on later, and who comes next and when. The lists
 * follow what is being typed, so a setting can be tried before it is saved —
 * and a save that would put tenants in front of the next run asks first,
 * naming them. Any tenant in a list can be kept out of both steps.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Play, Save } from 'lucide-react';
import {
  TENANT_AUTOMATION_MAX_DAYS,
  TENANT_AUTOMATION_MAX_NOTICE_DAYS,
  TENANT_AUTOMATION_MIN_DAYS,
  tenantAutomationArchiveRetentionDays,
  type TenantAutomationCandidate,
  type TenantAutomationKept,
  type TenantAutomationRun,
  type TenantAutomationSettings,
  type TenantAutomationSettingsUpdate,
  type TenantAutomationStatus,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import TimeCell from '@/components/ui/TimeCell';
import { extractOperatorError } from '@/lib/extract-operator-error';
import {
  changedSettings,
  daysSince,
  newlyDue,
  reachCount,
  reachedNow,
  splitByDue,
  tenantCount,
  whyNotYet,
  type DatedCandidate,
  type NewlyDue,
} from '@/lib/tenant-automation';
import {
  useRunTenantAutomation,
  useSaveTenantAutomation,
  useSetTenantAutomationExempt,
  useTenantAutomation,
} from '@/hooks/use-tenant-automation';
import TenantAutomationConfirmModal from './TenantAutomationConfirmModal';

/** Tenants named in a list before the rest is folded into a count. */
const LIST_LIMIT = 5;

type Step = 'archive' | 'delete';

const STEP_TEXT: Record<Step, { verb: string; done: string; state: string; noun: string }> = {
  archive: { verb: 'archived', done: 'Archive', state: 'suspended', noun: 'suspension' },
  delete: { verb: 'deleted', done: 'Delete', state: 'archived', noun: 'archive' },
};

/** A day count as typed. Null while it is not a whole number within the limits. */
function parseDays(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= TENANT_AUTOMATION_MIN_DAYS && n <= TENANT_AUTOMATION_MAX_DAYS ? n : null;
}

/** A notice period as typed: 0 tells nobody. Null while it is not usable. */
function parseNotice(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n <= TENANT_AUTOMATION_MAX_NOTICE_DAYS ? n : null;
}

interface DraftState {
  readonly autoArchiveEnabled: boolean;
  readonly autoArchiveAfterDays: string;
  readonly autoDeleteEnabled: boolean;
  readonly autoDeleteAfterDays: string;
  readonly noticeDays: string;
}

const toDraft = (s: TenantAutomationSettings): DraftState => ({
  autoArchiveEnabled: s.autoArchiveEnabled,
  autoArchiveAfterDays: String(s.autoArchiveAfterDays),
  autoDeleteEnabled: s.autoDeleteEnabled,
  autoDeleteAfterDays: String(s.autoDeleteAfterDays),
  noticeDays: String(s.noticeDays),
});

export default function TenantAutomationCard() {
  const query = useTenantAutomation();
  const save = useSaveTenantAutomation();
  const run = useRunTenantAutomation();
  const exempt = useSetTenantAutomationExempt();
  const status = query.data?.data;

  // Only what the operator has touched. Everything else follows the server,
  // so a setting another admin changes meanwhile shows up here — and is not
  // sent back, old, with this operator's save.
  const [draft, setDraft] = useState<Partial<DraftState>>({});
  const [confirm, setConfirm] = useState<{ kind: 'save' | 'run'; due: NewlyDue; update: TenantAutomationSettingsUpdate } | null>(null);
  const [checking, setChecking] = useState(false);
  // The lists compare dates with "now"; a card left open must not go on
  // showing yesterday's answer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const saved = status?.settings;
  const shown: DraftState | null = saved ? { ...toDraft(saved), ...draft } : null;

  const archiveDays = shown ? parseDays(shown.autoArchiveAfterDays) : null;
  const deleteDays = shown ? parseDays(shown.autoDeleteAfterDays) : null;
  const noticeDays = shown ? parseNotice(shown.noticeDays) : null;
  /** What would be stored after a save, given stored settings `on`; null while a number is unusable. */
  const nextOver = (on: TenantAutomationSettings): TenantAutomationSettings | null => {
    const merged = { ...toDraft(on), ...draft };
    const a = parseDays(merged.autoArchiveAfterDays);
    const d = parseDays(merged.autoDeleteAfterDays);
    const n = parseNotice(merged.noticeDays);
    return a === null || d === null || n === null ? null : {
      autoArchiveEnabled: merged.autoArchiveEnabled,
      autoArchiveAfterDays: a,
      autoDeleteEnabled: merged.autoDeleteEnabled,
      autoDeleteAfterDays: d,
      noticeDays: n,
    };
  };
  const next = saved ? nextOver(saved) : null;
  const dirty = !!saved && !!shown && (next === null || Object.keys(changedSettings(saved, next)).length > 0);

  if (query.isLoading) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="tenant-automation-card">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading automatic archive and delete…
        </div>
      </section>
    );
  }
  if (query.error || !status || !shown || !saved) {
    return (
      <section data-testid="tenant-automation-card">
        <ErrorPanel
          error={extractOperatorError(query.error ?? new Error('The automatic archive and delete settings could not be loaded.'))}
          severity="error"
          onRetry={() => { void query.refetch(); }}
          retryPending={query.isFetching}
          testId="tenant-automation-load-error"
        />
      </section>
    );
  }

  const change = (patch: Partial<DraftState>): void => {
    save.reset();
    setDraft({ ...draft, ...patch });
  };

  /**
   * The status as it is this moment. A save and a run are decided — and the
   * tenants they reach named — against that, not against what the card
   * loaded when it was opened.
   */
  const freshStatus = async (): Promise<TenantAutomationStatus | null> => {
    setChecking(true);
    try {
      const res = await query.refetch();
      return res.data?.data ?? null;
    } finally {
      setChecking(false);
    }
  };

  const doSave = async (update: TenantAutomationSettingsUpdate): Promise<void> => {
    try {
      await save.mutateAsync(update);
      setDraft({});
      setConfirm(null);
    } catch { /* shown by the panel below, or in the dialog */ }
  };
  const onSave = async (): Promise<void> => {
    const fresh = await freshStatus();
    if (!fresh) return;                       // the card shows why it could not be read
    const target = nextOver(fresh.settings);
    if (!target) return;
    const update = changedSettings(fresh.settings, target);
    if (Object.keys(update).length === 0) { setDraft({}); return; }   // somebody saved the same meanwhile
    const due = newlyDue(fresh, target, Date.now());
    if (reachCount(due) > 0) setConfirm({ kind: 'save', due, update });
    else await doSave(update);
  };

  const doRun = async (): Promise<void> => {
    try {
      await run.mutateAsync();
      setConfirm(null);
    } catch { /* shown by the panel below, or in the dialog */ }
  };
  const onRun = async (): Promise<void> => {
    run.reset();
    const fresh = await freshStatus();
    if (!fresh) return;
    const due = reachedNow(fresh, fresh.settings, Date.now());
    if (reachCount(due) > 0) setConfirm({ kind: 'run', due, update: {} });
    else await doRun();
  };

  const bothOff = !saved.autoArchiveEnabled && !saved.autoDeleteEnabled;
  // The lists under the switches are worked out with the notice period being
  // typed, or the stored one while what is typed is not a usable number.
  const previewNotice = noticeDays ?? saved.noticeDays;
  const retention = tenantAutomationArchiveRetentionDays(
    { autoDeleteEnabled: shown.autoDeleteEnabled, autoDeleteAfterDays: deleteDays ?? saved.autoDeleteAfterDays, noticeDays: previewNotice },
    status.archiveRetentionDays,
  );
  const keepOut = (tenantId: string, value: boolean): void => {
    exempt.mutate({ tenantId, exempt: value });
  };
  const keepProps = { onKeepOut: (tenantId: string) => keepOut(tenantId, true), keepPending: exempt.isPending };

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid="tenant-automation-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Automatic archive and delete</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" data-testid="tenant-automation-schedule">
            Checked every {status.intervalHours} hours.{' '}
            <RunLine status={status} />
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void onRun(); }}
          disabled={run.isPending || checking || status.running || dirty || bothOff}
          title={
            dirty ? 'Save or discard your changes first'
              : bothOff ? 'Both steps are off'
                : status.running ? 'A run is under way'
                  : 'Check now instead of waiting for the next run'
          }
          className="inline-flex shrink-0 items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tenant-automation-run-now"
        >
          {run.isPending || status.running || (checking && !dirty) ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run now
        </button>
      </div>

      {run.error && !confirm && (
        <div className="px-4 pt-3">
          <ErrorPanel error={extractOperatorError(run.error)} severity="error" compact testId="tenant-automation-run-error" />
        </div>
      )}

      <LastRunProblems run={status.lastRun} />

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        <StepRow
          step="archive"
          enabled={shown.autoArchiveEnabled}
          days={shown.autoArchiveAfterDays}
          parsedDays={archiveDays}
          noticeDays={previewNotice}
          candidates={status.suspended}
          nowMs={nowMs}
          {...keepProps}
          disabled={save.isPending}
          onToggle={(v) => change({ autoArchiveEnabled: v })}
          onDays={(v) => change({ autoArchiveAfterDays: v })}
          blocked={!!status.archiveBlockedReason}
          explanation={
            <>
              Archiving copies a tenant&apos;s files to the backup target, then deletes its mailboxes, aliases,
              deployments and storage volume. The tenant can be restored for as long as the archive is kept
              ({retention} days).
            </>
          }
          warning={status.archiveBlockedReason && (shown.autoArchiveEnabled || saved.autoArchiveEnabled) ? (
            <p className="flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200" data-testid="tenant-automation-archive-blocked">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                No archive can be taken right now, so suspended tenants stay as they are: {status.archiveBlockedReason}{' '}
                <Link to="/backups/targets" className="underline hover:no-underline">Backup targets</Link>
              </span>
            </p>
          ) : null}
        />
        <StepRow
          step="delete"
          enabled={shown.autoDeleteEnabled}
          days={shown.autoDeleteAfterDays}
          parsedDays={deleteDays}
          noticeDays={previewNotice}
          candidates={status.archived}
          nowMs={nowMs}
          {...keepProps}
          disabled={save.isPending}
          onToggle={(v) => change({ autoDeleteEnabled: v })}
          onDays={(v) => change({ autoDeleteAfterDays: v })}
          blocked={false}
          explanation={
            <>
              Deleting removes the tenant and everything it owns. It can be recovered under{' '}
              <Link to="/backups/disaster-recovery" className="underline hover:no-underline">Disaster Recovery</Link>{' '}
              only for as long as its backups are kept.
            </>
          }
          warning={null}
        />
        <NoticeRow
          value={shown.noticeDays}
          parsed={noticeDays}
          disabled={save.isPending}
          onChange={(v) => change({ noticeDays: v })}
        />
        <KeptRow
          kept={status.kept}
          pending={exempt.isPending}
          error={exempt.error}
          onPutBack={(tenantId) => keepOut(tenantId, false)}
        />
      </div>

      {(dirty || save.error) && (
        <div className="space-y-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          {save.error && !confirm && (
            <ErrorPanel error={extractOperatorError(save.error)} severity="error" compact testId="tenant-automation-save-error" />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void onSave(); }}
              disabled={!dirty || next === null || save.isPending || checking}
              className="inline-flex items-center gap-1.5 rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="tenant-automation-save"
            >
              {save.isPending || (checking && dirty) ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
            <button
              type="button"
              onClick={() => { save.reset(); setDraft({}); }}
              disabled={save.isPending}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              data-testid="tenant-automation-discard"
            >
              Discard
            </button>
            {next === null && (
              <span className="text-xs text-red-700 dark:text-red-300" data-testid="tenant-automation-days-invalid">
                {noticeDays === null
                  ? `The notice period is a whole number of days from 0 to ${TENANT_AUTOMATION_MAX_NOTICE_DAYS}.`
                  : `A limit is a whole number of days from ${TENANT_AUTOMATION_MIN_DAYS} to ${TENANT_AUTOMATION_MAX_DAYS}.`}
              </span>
            )}
          </div>
        </div>
      )}

      {confirm && (
        <TenantAutomationConfirmModal
          kind={confirm.kind}
          due={confirm.due}
          intervalHours={status.intervalHours}
          pending={confirm.kind === 'save' ? save.isPending : run.isPending}
          error={(confirm.kind === 'save' ? save.error : run.error) ?? null}
          onConfirm={() => { void (confirm.kind === 'save' ? doSave(confirm.update) : doRun()); }}
          onClose={() => { save.reset(); run.reset(); setConfirm(null); }}
        />
      )}
    </section>
  );
}

/** "Last run 2h ago: archived 1." / "A run is under way." / "Next run about 14:10." */
function RunLine({ status }: { readonly status: TenantAutomationStatus }) {
  if (status.running) {
    return <span className="text-blue-700 dark:text-blue-300" data-testid="tenant-automation-running">A run is under way.</span>;
  }
  const last = status.lastRun;
  const did = last
    ? [
        last.archived.length > 0 ? `archived ${last.archived.length}` : '',
        last.deleted.length > 0 ? `deleted ${last.deleted.length}` : '',
        // A message that reached nobody told nobody.
        last.told.some((t) => t.reached) ? `told ${last.told.filter((t) => t.reached).length}` : '',
        last.told.some((t) => !t.reached) ? `could not tell ${last.told.filter((t) => !t.reached).length}` : '',
        last.failed.length > 0 ? `failed on ${last.failed.length}` : '',
      ].filter(Boolean)
    : [];
  return (
    <>
      {last ? (
        <span data-testid="tenant-automation-last-run">
          Last run <TimeCell iso={last.finishedAt} />: {did.length > 0 ? did.join(', ') : 'nothing was due'}.
        </span>
      ) : (
        <span data-testid="tenant-automation-last-run">It has not run yet.</span>
      )}
      {status.nextRunAt && (
        <> Next run about <time dateTime={status.nextRunAt} title={new Date(status.nextRunAt).toLocaleString()}>{new Date(status.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>.</>
      )}
    </>
  );
}

/** What the last run could not do — kept in view until a later run does it. */
function LastRunProblems({ run }: { readonly run: TenantAutomationRun | null }) {
  const unreached = run ? run.told.filter((t) => !t.reached) : [];
  if (!run || (run.failed.length === 0 && run.errors.length === 0 && !run.archiveSkippedReason && unreached.length === 0)) return null;
  const undone = run.failed.length > 0 || run.errors.length > 0 || !!run.archiveSkippedReason;
  return (
    <div className="px-4 pt-3" data-testid="tenant-automation-last-run-problems">
      <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-700/60 dark:bg-red-900/30 dark:text-red-200">
        <p className="font-medium">
          {undone ? 'The last run did not do everything that was due.' : 'The last run could not tell everybody it had to.'}
        </p>
        {run.archiveSkippedReason && <p className="mt-1">No archive could be taken: {run.archiveSkippedReason}</p>}
        {run.errors.map((e) => <p key={e} className="mt-1">{e}</p>)}
        {unreached.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4" data-testid="tenant-automation-unreached">
            {unreached.map((t) => (
              <li key={`${t.action}-${t.tenantId}`}>
                Nobody could be told at{' '}
                <Link to={`/tenants/${t.tenantId}`} className="font-medium underline hover:no-underline">{t.name}</Link>
                {' '}— no user and no contact address to write to, or notifications are off. It is told again at every run and
                not {t.action}d until the message reaches somebody.
              </li>
            ))}
          </ul>
        )}
        {run.failed.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {run.failed.map((f) => (
              <li key={`${f.action}-${f.tenantId}`}>
                Could not {f.action}{' '}
                <Link to={`/tenants/${f.tenantId}`} className="font-medium underline hover:no-underline">{f.name}</Link>: {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface StepRowProps {
  readonly step: Step;
  readonly enabled: boolean;
  readonly days: string;
  readonly parsedDays: number | null;
  /** The notice period the lists are worked out with. */
  readonly noticeDays: number;
  readonly candidates: readonly TenantAutomationCandidate[];
  readonly nowMs: number;
  readonly onKeepOut: (tenantId: string) => void;
  readonly keepPending: boolean;
  readonly disabled: boolean;
  readonly onToggle: (value: boolean) => void;
  readonly onDays: (value: string) => void;
  /** The step cannot act at the moment, whoever is due (no archive can be taken). */
  readonly blocked: boolean;
  readonly explanation: React.ReactNode;
  readonly warning: React.ReactNode;
}

function StepRow({ step, enabled, days, parsedDays, noticeDays, candidates, nowMs, onKeepOut, keepPending, disabled, onToggle, onDays, blocked, explanation, warning }: StepRowProps) {
  const text = STEP_TEXT[step];
  const label = step === 'archive' ? 'Archive suspended tenants' : 'Delete archived tenants';
  return (
    <div className="flex gap-3 px-4 py-3" data-testid={`tenant-automation-${step}`}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={disabled}
        onClick={() => onToggle(!enabled)}
        data-testid={`tenant-automation-${step}-toggle`}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-gray-800 ${
          enabled ? (step === 'delete' ? 'bg-red-600' : 'bg-brand-500') : 'bg-gray-300 dark:bg-gray-600'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`}
        />
      </button>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-900 dark:text-gray-100">
          <span className="font-medium">{label}</span>
          <label className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
            after
            <input
              type="number"
              inputMode="numeric"
              min={TENANT_AUTOMATION_MIN_DAYS}
              max={TENANT_AUTOMATION_MAX_DAYS}
              step={1}
              value={days}
              disabled={disabled}
              onChange={(e) => onDays(e.target.value)}
              aria-invalid={parsedDays === null}
              aria-label={`Days a tenant stays ${text.state} before it is ${text.verb}`}
              data-testid={`tenant-automation-${step}-days`}
              className={`w-20 rounded-md border bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60 dark:bg-gray-700 dark:text-gray-100 ${
                parsedDays === null ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
              }`}
            />
            days
          </label>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{explanation}</p>
        {warning}
        {parsedDays !== null && (
          <StepPreview
            step={step}
            enabled={enabled}
            blocked={blocked}
            days={parsedDays}
            noticeDays={noticeDays}
            candidates={candidates}
            nowMs={nowMs}
            onKeepOut={onKeepOut}
            keepPending={keepPending}
          />
        )}
      </div>
    </div>
  );
}

interface StepPreviewProps {
  readonly step: Step;
  readonly enabled: boolean;
  readonly blocked: boolean;
  readonly days: number;
  readonly noticeDays: number;
  readonly candidates: readonly TenantAutomationCandidate[];
  readonly nowMs: number;
  readonly onKeepOut: (tenantId: string) => void;
  readonly keepPending: boolean;
}

/** Who these settings reach: at the next run, and after it. */
function StepPreview({ step, enabled, blocked, days, noticeDays, candidates, nowMs, onKeepOut, keepPending }: StepPreviewProps) {
  const text = STEP_TEXT[step];
  const { dueNow, toTell, later, undated } = splitByDue(candidates, days, noticeDays, nowMs);

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`tenant-automation-${step}-preview`}>
        No tenant is {text.state} at the moment.
      </p>
    );
  }

  const accent = step === 'delete'
    ? 'text-red-800 dark:text-red-200'
    : 'text-amber-800 dark:text-amber-200';
  const heading = enabled ? `font-medium ${accent}` : 'text-gray-600 dark:text-gray-300';
  const next = later[0];

  return (
    <div className="space-y-1 text-xs" data-testid={`tenant-automation-${step}-preview`}>
      {dueNow.length > 0 && (
        <CandidateList
          testId={`tenant-automation-${step}-due-now`}
          headingClass={heading}
          heading={
            !enabled
              ? `Off. Switched on, ${tenantCount(dueNow.length)} would be ${text.verb} at the next run:`
              : blocked
                ? `${tenantCount(dueNow.length)} due — not ${text.verb} while no archive can be taken:`
                : `${tenantCount(dueNow.length)} due — ${text.verb} at the next run:`
          }
          candidates={dueNow}
          step={step}
          nowMs={nowMs}
          onKeepOut={onKeepOut}
          keepPending={keepPending}
        />
      )}
      {toTell.length > 0 && (
        <CandidateList
          testId={`tenant-automation-${step}-to-tell`}
          headingClass={heading}
          heading={
            !enabled
              ? `Off. Switched on, ${tenantCount(toTell.length)} would be told at the next run, and ${text.verb} on the date given:`
              : blocked
                ? `${tenantCount(toTell.length)} to tell — not told while no archive can be taken:`
                : `${tenantCount(toTell.length)} told at the next run, and ${text.verb} on the date given:`
          }
          candidates={toTell}
          showDate
          step={step}
          nowMs={nowMs}
          onKeepOut={onKeepOut}
          keepPending={keepPending}
        />
      )}
      {dueNow.length + toTell.length === 0 && (
        <p className="text-gray-600 dark:text-gray-300" data-testid={`tenant-automation-${step}-due-now`}>
          {enabled ? '' : 'Off. '}
          {tenantCount(candidates.length)} {text.state}, none due.
        </p>
      )}
      {next && (
        <p className="flex flex-wrap items-center gap-x-1 text-gray-600 dark:text-gray-300" data-testid={`tenant-automation-${step}-next`}>
          <span>
            {enabled ? 'Next' : 'First to come due'}:{' '}
            <Link to={`/tenants/${next.tenantId}`} className="font-medium text-gray-900 hover:underline dark:text-gray-100">{next.name}</Link>
            {' '}on {new Date(next.dueAt).toLocaleDateString()}
            {next.told
              ? ' (it has been told)'
              : next.tellAt !== null ? ` (it will be told on ${new Date(next.tellAt).toLocaleDateString()})` : ''}
            {later.length > 1 ? `, then ${later.length - 1} more.` : '.'}
          </span>
          <KeepOutButton tenantId={next.tenantId} name={next.name} onKeepOut={onKeepOut} pending={keepPending} />
        </p>
      )}
      {undated.length > 0 && (
        <p className="text-gray-500 dark:text-gray-400" data-testid={`tenant-automation-${step}-undated`}>
          {tenantCount(undated.length)} with no recorded {text.noun} date {undated.length === 1 ? 'is' : 'are'} never {text.verb} automatically.
        </p>
      )}
    </div>
  );
}

interface CandidateListProps {
  readonly testId: string;
  readonly heading: string;
  readonly headingClass: string;
  readonly candidates: readonly DatedCandidate[];
  /** Name the date each tenant is acted on (a tenant that is told gets one). */
  readonly showDate?: boolean;
  readonly step: Step;
  readonly nowMs: number;
  readonly onKeepOut: (tenantId: string) => void;
  readonly keepPending: boolean;
}

function CandidateList({ testId, heading, headingClass, candidates, showDate, step, nowMs, onKeepOut, keepPending }: CandidateListProps) {
  const [showAll, setShowAll] = useState(false);
  const listed = showAll ? candidates : candidates.slice(0, LIST_LIMIT);
  return (
    <>
      <p className={headingClass} data-testid={testId}>{heading}</p>
      <ul className="space-y-0.5 pl-1">
        {listed.map((c) => (
          <CandidateLine key={c.tenantId} candidate={c} step={step} showDate={showDate === true} nowMs={nowMs} onKeepOut={onKeepOut} keepPending={keepPending} />
        ))}
      </ul>
      {candidates.length > LIST_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="text-brand-600 hover:underline dark:text-brand-400"
          data-testid={`${testId}-show-all`}
        >
          {showAll ? 'Show fewer' : `Show all ${candidates.length}`}
        </button>
      )}
    </>
  );
}

interface CandidateLineProps {
  readonly candidate: DatedCandidate;
  readonly step: Step;
  readonly showDate: boolean;
  readonly nowMs: number;
  readonly onKeepOut: (tenantId: string) => void;
  readonly keepPending: boolean;
}

function CandidateLine({ candidate, step, showDate, nowMs, onKeepOut, keepPending }: CandidateLineProps) {
  const text = STEP_TEXT[step];
  const days = candidate.since ? daysSince(candidate.since, nowMs) : 0;
  return (
    <li className="flex flex-wrap items-center gap-x-1 text-gray-700 dark:text-gray-300" data-testid={`tenant-automation-due-${candidate.tenantId}`}>
      <span>
        <Link to={`/tenants/${candidate.tenantId}`} className="font-medium text-gray-900 hover:underline dark:text-gray-100">{candidate.name}</Link>
        {' '}— {text.state} {days} day{days === 1 ? '' : 's'} ago
        {showDate && <>, {text.done.toLowerCase()} on {new Date(candidate.dueAt).toLocaleDateString()}</>}
        {showDate && candidate.notice && !candidate.notice.reached && (
          <span className="text-red-700 dark:text-red-300"> (the last message reached nobody)</span>
        )}
        {!showDate && candidate.notice?.reached && <>, told <TimeCell iso={candidate.notice.toldAt} /></>}
        {candidate.busy && (
          <span className="text-gray-500 dark:text-gray-400"> ({whyNotYet(candidate.busy)})</span>
        )}
      </span>
      <KeepOutButton tenantId={candidate.tenantId} name={candidate.name} onKeepOut={onKeepOut} pending={keepPending} />
    </li>
  );
}

function KeepOutButton({ tenantId, name, onKeepOut, pending }: { readonly tenantId: string; readonly name: string; readonly onKeepOut: (tenantId: string) => void; readonly pending: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onKeepOut(tenantId)}
      disabled={pending}
      title="Never archive or delete this tenant automatically"
      aria-label={`Keep ${name} out of automatic archive and delete`}
      className="rounded border border-gray-300 px-1.5 text-[11px] leading-5 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
      data-testid={`tenant-automation-keep-out-${tenantId}`}
    >
      Keep out
    </button>
  );
}

interface NoticeRowProps {
  readonly value: string;
  readonly parsed: number | null;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}

/** The notice period: how long before its archive or delete a tenant hears of it. */
function NoticeRow({ value, parsed, disabled, onChange }: NoticeRowProps) {
  return (
    <div className="flex gap-3 px-4 py-3" data-testid="tenant-automation-notice">
      {/* As wide as a switch, so the three rows line up. */}
      <div className="w-11 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <label className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-gray-900 dark:text-gray-100">
          <span className="font-medium">Tell the tenant</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={TENANT_AUTOMATION_MAX_NOTICE_DAYS}
            step={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={parsed === null}
            aria-label="Days ahead a tenant is told that it will be archived or deleted"
            data-testid="tenant-automation-notice-days"
            className={`w-20 rounded-md border bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60 dark:bg-gray-700 dark:text-gray-100 ${
              parsed === null ? 'border-red-500 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
            }`}
          />
          <span className="text-gray-700 dark:text-gray-300">days ahead</span>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="tenant-automation-notice-explanation">
          {parsed === 0
            ? 'Nobody is told. A tenant is archived or deleted at the first run after it passes its limit — one that was given a date already keeps it.'
            : 'Each tenant gets a message with the date — its admins in the panel and by email, the account\u2019s contact address by email — and nothing happens to it before that date. A tenant already past its limit is told at the next run and given this many days; one nobody could be told is left as it is. 0 tells nobody.'}
        </p>
      </div>
    </div>
  );
}

interface KeptRowProps {
  readonly kept: readonly TenantAutomationKept[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onPutBack: (tenantId: string) => void;
}

/** The tenants kept out of both steps, and the way back in. */
function KeptRow({ kept, pending, error, onPutBack }: KeptRowProps) {
  return (
    <div className="flex gap-3 px-4 py-3" data-testid="tenant-automation-kept">
      <div className="w-11 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5 text-xs">
        {error ? <ErrorPanel error={extractOperatorError(error)} severity="error" compact testId="tenant-automation-keep-error" /> : null}
        {kept.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">
            No tenant is kept out. Keep one out with the button next to its name above, or under Actions on its own page — it is then never
            archived or deleted automatically.
          </p>
        ) : (
          <>
            <p className="text-gray-700 dark:text-gray-300">
              Kept out — never archived or deleted automatically ({kept.length}):
            </p>
            <ul className="space-y-0.5 pl-1">
              {kept.map((t) => (
                <li key={t.tenantId} className="flex flex-wrap items-center gap-x-1 text-gray-700 dark:text-gray-300" data-testid={`tenant-automation-kept-${t.tenantId}`}>
                  <span>
                    <Link to={`/tenants/${t.tenantId}`} className="font-medium text-gray-900 hover:underline dark:text-gray-100">{t.name}</Link>
                    {' '}— {t.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => onPutBack(t.tenantId)}
                    disabled={pending}
                    aria-label={`Put ${t.name} back into automatic archive and delete`}
                    className="rounded border border-gray-300 px-1.5 text-[11px] leading-5 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    data-testid={`tenant-automation-put-back-${t.tenantId}`}
                  >
                    Put back
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
