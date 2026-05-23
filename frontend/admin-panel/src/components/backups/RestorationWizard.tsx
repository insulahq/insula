/**
 * `<RestorationWizard>` — the modal shipped in Phase 6 of the
 * Backups UI redesign.
 *
 * Per the operator IA decision: clicking any snapshot or backup row
 * opens a wizard that walks the operator through three steps, then
 * fires the restore as a fire-and-forget task. The page closes the
 * modal in <1s; progress is tracked by the task-center chip — the
 * same UX pattern shipped for shim target-switch 2026-05-21.
 *
 * The wizard is artifact-shape-agnostic: callers pass an `artifact`
 * descriptor with everything needed to render the steps + an
 * `onSubmit` callback that runs the restore. Three top-level shapes:
 *
 *   - snapshot           → in-cluster CSI restore (PVC clone or rollback)
 *   - backup             → off-cluster artifact restore from a target
 *   - tenant-bundle      → routes the operator into the existing
 *                          Plesk-style RestoreCart for component picking
 *
 * Steps:
 *   1. What to restore — defaults to "everything"; the tenant-bundle
 *      flow swaps in a "Pick components" radio that links out to
 *      the RestoreCart.
 *   2. Where to restore — in-place (overwrite) vs side-by-side
 *      (suffixed copy).
 *   3. Pre-checks + confirm — non-blocking warnings the caller can
 *      inject via `prechecks`. Operator clicks "Start restore"; the
 *      onSubmit promise resolves with a `taskId` and the modal closes.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertTriangle,
  Check,
  Archive,
  HardDrive,
  Package,
} from 'lucide-react';

export type RestoreKind = 'snapshot' | 'backup' | 'tenant-bundle';

export interface RestoreArtifact {
  /** Drives copy + behaviour throughout the wizard. */
  readonly kind: RestoreKind;
  /** Short identifier shown in the header (e.g. snapshot id, backup name). */
  readonly id: string;
  /** Human-friendly name (tenant name, PVC, mailbox, etc.). */
  readonly displayName: string;
  /** Optional: when set the wizard renders the artifact's size as context. */
  readonly sizeBytes?: number;
  /** Optional: creation timestamp shown in the header. */
  readonly createdAt?: string | null;
  /** Optional: a deep-link the tenant-bundle "Pick components" step uses
   *  to launch the existing RestoreCart UI. Only honoured when
   *  `kind === 'tenant-bundle'`. */
  readonly cartUrl?: string;
}

export type RestoreScope = 'all' | 'components';
export type RestoreLocation = 'in-place' | 'side-by-side';

export interface RestoreSelection {
  readonly scope: RestoreScope;
  readonly location: RestoreLocation;
}

export interface RestorationWizardPrecheck {
  readonly severity: 'info' | 'warn';
  readonly message: string;
}

export interface RestorationWizardProps {
  readonly artifact: RestoreArtifact;
  /** Optional non-blocking warnings to render on step 3. */
  readonly prechecks?: ReadonlyArray<RestorationWizardPrecheck>;
  /** When non-null, disables the Start button + shows the reason in a
   *  rose-red error banner. Use for HARD blocking gates (lock held,
   *  snapshot not ready, etc.). For "still loading" states use
   *  `submitPending` instead — that one renders a neutral indicator. */
  readonly blockSubmit?: string | null;
  /** When non-null, disables the Start button + shows a neutral
   *  spinner-style label. Use for pending precheck calls so the
   *  operator doesn't confuse "loading" with "failed". */
  readonly submitPending?: string | null;
  /** When true, hides the Step 2 (Where) entirely. Use for restore
   *  flows where the location is structurally fixed — e.g. CNPG PITR
   *  always replaces the source cluster. */
  readonly hideWhereStep?: boolean;
  readonly onClose: () => void;
  /** Caller-provided restore dispatcher. Returns the task id created
   *  by the backend so the wizard can pass it through `onCompleted`. */
  readonly onSubmit: (selection: RestoreSelection) => Promise<{ taskId: string }>;
  /** Optional hook called with the taskId after submit resolves. */
  readonly onCompleted?: (taskId: string) => void;
}

function formatBytes(b?: number): string | null {
  if (b == null) return null;
  if (b === 0) return '0 B';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b} B`;
}

const ARTIFACT_ICON: Record<RestoreKind, typeof Archive> = {
  snapshot: HardDrive,
  backup: Archive,
  'tenant-bundle': Package,
};

const ARTIFACT_VERB: Record<RestoreKind, string> = {
  snapshot: 'snapshot',
  backup: 'backup',
  'tenant-bundle': 'tenant bundle',
};

export default function RestorationWizard({
  artifact,
  prechecks,
  blockSubmit,
  submitPending,
  hideWhereStep,
  onClose,
  onSubmit,
  onCompleted,
}: RestorationWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [scope, setScope] = useState<RestoreScope>('all');
  // When the location step is suppressed (CNPG PITR always replaces
  // the source cluster), default to 'in-place' so the consumer sees
  // a sane RestoreSelection.location value.
  const [location, setLocation] = useState<RestoreLocation>(hideWhereStep ? 'in-place' : 'side-by-side');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against an external `setStep(2)` while `hideWhereStep` is set —
  // the Step 2 pane is suppressed so step=2 would render a blank panel.
  // Snap back to 1 if anyone manages to drive us into that state (e.g.
  // a test or a future caller).
  useEffect(() => {
    if (hideWhereStep && step === 2) setStep(1);
  }, [hideWhereStep, step]);

  const Icon = ARTIFACT_ICON[artifact.kind];
  const verb = ARTIFACT_VERB[artifact.kind];

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { taskId } = await onSubmit({ scope, location });
      onCompleted?.(taskId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore could not be started');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restoration-wizard-title"
      data-testid="restoration-wizard"
    >
      <div className="w-full max-w-xl rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-start gap-2">
            <Icon size={18} className="mt-0.5 text-gray-700 dark:text-gray-300" />
            <div>
              <h2
                id="restoration-wizard-title"
                className="text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                Restore {verb}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-mono">{artifact.displayName}</span>
                {artifact.createdAt && (
                  <> · created {new Date(artifact.createdAt).toLocaleString()}</>
                )}
                {formatBytes(artifact.sizeBytes) && <> · {formatBytes(artifact.sizeBytes)}</>}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <X size={16} />
          </button>
        </header>

        <ol
          className="flex border-b border-gray-200 dark:border-gray-700"
          aria-label="Restore steps"
        >
          {(hideWhereStep ? [1, 3] : [1, 2, 3]).map((n) => (
            <li
              key={n}
              className={
                step === n
                  ? 'flex-1 border-b-2 border-brand-500 px-4 py-2 text-center text-xs font-semibold text-brand-600 dark:text-brand-300'
                  : 'flex-1 px-4 py-2 text-center text-xs text-gray-500 dark:text-gray-400'
              }
              aria-current={step === n ? 'step' : undefined}
            >
              {n === 1 && '1. What'}
              {n === 2 && '2. Where'}
              {n === 3 && (hideWhereStep ? '2. Confirm' : '3. Confirm')}
            </li>
          ))}
        </ol>

        <div className="p-4 text-sm">
          {step === 1 && (
            <Step1
              artifact={artifact}
              scope={scope}
              setScope={setScope}
              onLaunchCart={() => {
                if (artifact.cartUrl) {
                  onClose();
                  navigate(artifact.cartUrl);
                }
              }}
            />
          )}
          {step === 2 && !hideWhereStep && <Step2 location={location} setLocation={setLocation} verb={verb} />}
          {step === 3 && (
            <Step3 artifact={artifact} scope={scope} location={location} prechecks={prechecks} />
          )}
        </div>

        {error && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <footer className="flex flex-col gap-2 border-t border-gray-200 p-3 dark:border-gray-700">
          {/* Loading state — neutral. Distinguished from blockSubmit
              so operators don't confuse pending prechecks with failure. */}
          {submitPending && step === 3 && !blockSubmit && (
            <div
              role="status"
              className="flex items-start gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              data-testid="restoration-wizard-submit-pending"
            >
              <Loader2 size={14} className="mt-0.5 flex-shrink-0 animate-spin" />
              <span>{submitPending}</span>
            </div>
          )}
          {blockSubmit && step === 3 && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
              data-testid="restoration-wizard-block-reason"
            >
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{blockSubmit}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep((s) => {
                if (s <= 1) return s;
                // When Step 2 is hidden, Back from Step 3 jumps to Step 1.
                if (hideWhereStep && s === 3) return 1;
                return (s - 1) as 1 | 2;
              })}
              disabled={step === 1 || submitting}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <ChevronLeft size={12} /> Back
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => {
                  if (s >= 3) return s;
                  // When Step 2 is hidden, Next from Step 1 jumps to Step 3.
                  if (hideWhereStep && s === 1) return 3;
                  return (s + 1) as 2 | 3;
                })}
                className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
                data-testid="restoration-wizard-next"
              >
                Next <ChevronRight size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || blockSubmit != null || submitPending != null}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                data-testid="restoration-wizard-start"
              >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {submitting ? 'Starting…' : 'Start restore'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── steps ───────────────────────────────────────────────────────────

function Step1({
  artifact,
  scope,
  setScope,
  onLaunchCart,
}: {
  readonly artifact: RestoreArtifact;
  readonly scope: RestoreScope;
  readonly setScope: (v: RestoreScope) => void;
  readonly onLaunchCart: () => void;
}) {
  const isBundle = artifact.kind === 'tenant-bundle';
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        What to restore
      </legend>
      <label className="flex items-start gap-2">
        <input
          type="radio"
          name="restore-scope"
          value="all"
          checked={scope === 'all'}
          onChange={() => setScope('all')}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">Everything</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Restore the entire {artifact.kind === 'tenant-bundle' ? 'bundle' : artifact.kind}.
          </span>
        </span>
      </label>
      {isBundle && (
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="restore-scope"
            value="components"
            checked={scope === 'components'}
            onChange={() => setScope('components')}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-gray-900 dark:text-gray-100">
              Pick components (Restore Cart)
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Choose files, mailboxes, or config separately. Opens the Plesk-style cart UI.
            </span>
            {scope === 'components' && artifact.cartUrl && (
              <button
                type="button"
                onClick={onLaunchCart}
                className="mt-2 inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600"
                data-testid="restoration-wizard-launch-cart"
              >
                Open Restore Cart
              </button>
            )}
          </span>
        </label>
      )}
    </fieldset>
  );
}

function Step2({
  location,
  setLocation,
  verb,
}: {
  readonly location: RestoreLocation;
  readonly setLocation: (v: RestoreLocation) => void;
  readonly verb: string;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Where to restore
      </legend>
      <label className="flex items-start gap-2">
        <input
          type="radio"
          name="restore-location"
          value="side-by-side"
          checked={location === 'side-by-side'}
          onChange={() => setLocation('side-by-side')}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">Side-by-side (recommended)</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Create a new resource suffixed with <code>-restored-{'{timestamp}'}</code>. Nothing existing is overwritten.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="radio"
          name="restore-location"
          value="in-place"
          checked={location === 'in-place'}
          onChange={() => setLocation('in-place')}
          className="mt-1"
        />
        <span>
          <span className="font-medium text-gray-900 dark:text-gray-100">In place (overwrite)</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Replace the current {verb}'s data. Destructive — current contents are lost.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

function Step3({
  artifact,
  scope,
  location,
  prechecks,
}: {
  readonly artifact: RestoreArtifact;
  readonly scope: RestoreScope;
  readonly location: RestoreLocation;
  readonly prechecks?: ReadonlyArray<RestorationWizardPrecheck>;
}) {
  const items: ReadonlyArray<RestorationWizardPrecheck> = prechecks ?? [
    {
      severity: location === 'in-place' ? 'warn' : 'info',
      message:
        location === 'in-place'
          ? 'In-place restore will overwrite the current contents. There is no automatic undo.'
          : 'Side-by-side restore creates a new resource — your current data is untouched.',
    },
  ];
  // Operator-facing "what to expect" panel (Task #101 2026-05-23).
  // Snapshot restores via this wizard ALWAYS use the no-WAL-target
  // fast-path. The orchestrator skips the temp-cluster steps + boots
  // the source directly from the snapshot LSN. Real timings captured
  // on staging:
  //   - recreate-source (snapshot bootstrap):  ~6 min
  //   - scale-up-to-source-ha (patch):          ~0.2s
  //   - wait-ha-stable (CNPG roll absorb):     ~3-4 min for HA, 0 for 1-instance
  //   - normalize-bootstrap + cleanup:          <1s combined
  // Total: ~6 min for single-instance, ~10 min for 3-instance HA.
  // We can't know HA count here without prechecks; show the range.
  const showScenarioPanel = artifact.kind === 'snapshot';
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Source</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{artifact.displayName}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Scope</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{scope}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Mode</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{location}</dd>
        </div>
      </dl>
      {showScenarioPanel && (
        <div className="rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-200">
          <div className="font-semibold">Expected timeline (no WAL replay — fast-path)</div>
          <ol className="mt-1.5 space-y-0.5 ml-4 list-decimal text-indigo-700 dark:text-indigo-300">
            <li><span className="font-mono">~6 min</span> — recreate source cluster (CNPG boots primary from snapshot)</li>
            <li><span className="font-mono">~0s</span> — patch HA scale + clean up</li>
            <li><span className="font-mono">~3-4 min</span> — wait for HA cluster fully stable (absorbs CNPG's post-scale-up rolling restart so the chip green-state matches reality)</li>
          </ol>
          <div className="mt-1.5">
            <strong>Total: ~10 min</strong> for an HA cluster, ~6 min for a single-instance.
            Track live progress via the task-center chip once you start the restore.
          </div>
        </div>
      )}
      <ul className="space-y-2" aria-label="Pre-flight checks">
        {items.map((c) => (
          <li
            key={c.message}
            className={
              c.severity === 'warn'
                ? 'flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200'
                : 'flex items-start gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200'
            }
          >
            {c.severity === 'warn' ? (
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            ) : (
              <Check size={14} className="mt-0.5 flex-shrink-0" />
            )}
            <span>{c.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
