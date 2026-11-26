/**
 * The tenant's administrator account on a database instance, inside the
 * Credentials card of DatabaseManagementModal.
 *
 * The instance's root / superuser login is the platform's and is never shown.
 * This account is the tenant's: full rights on all of their databases, no
 * right to create users (Database Users does that). The platform keeps its
 * password, so a new one is set here, not in SQL.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Eye, EyeOff, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DatabaseAdminAccount, DeploymentCredentialsResponse } from '@insula/api-contracts';
import { useRotateDatabaseAdminPassword } from '@/hooks/use-deployments';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { adminAccountScope, type ManagedDbEngine } from '@/lib/database-admin';
import ErrorPanel from './ErrorPanel';
import { CopyFieldButton } from './CopyFieldButton';

const MASK = '•'.repeat(12);

interface DatabaseAdminAccountCardProps {
  readonly tenantId: string | undefined;
  readonly deploymentId: string;
  /** Null unless `status` is `ready`. */
  readonly adminAccount: DatabaseAdminAccount | null;
  /** Why the account is shown or not (deployment-credentials.ts adminAccountStatus). */
  readonly status: DeploymentCredentialsResponse['adminAccountStatus'] | undefined;
  readonly engine: ManagedDbEngine | null;
  /** The account is set up only while the database runs. */
  readonly running: boolean;
  /** Still null after the panel stopped asking (use-credentials-awaiting-admin.ts). */
  readonly setupSlow: boolean;
  /** Ask once more, and wait again. */
  readonly onCheckAgain: () => void;
  readonly copiedField: string | null;
  readonly onCopy: (field: string, value: string) => void;
}

function Row({ label, children, testId }: { readonly label: string; readonly children: ReactNode; readonly testId: string }) {
  return (
    <div className="flex items-center justify-between text-sm" data-testid={testId}>
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 w-28 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function PendingState({ status, running, setupSlow, onCheckAgain }: {
  readonly status: DeploymentCredentialsResponse['adminAccountStatus'] | undefined;
  readonly running: boolean;
  readonly setupSlow: boolean;
  readonly onCheckAgain: () => void;
}) {
  if (status === 'restricted') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="admin-account-restricted">
        Only a tenant administrator can see this account&apos;s password: it reaches every database of this instance.
      </p>
    );
  }
  if (status === 'unavailable') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="admin-account-unavailable">
        This database has no administrator account here.
      </p>
    );
  }
  if (status === 'lost') {
    return (
      <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2" role="status" data-testid="admin-account-lost">
        <p className="text-sm text-red-800 dark:text-red-300">
          The platform has lost its administrator access to this database, so the SQL Manager, backups and restores
          cannot reach it. Your applications are not affected. An operator has been notified and can restore it.
        </p>
      </div>
    );
  }
  if (!running) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="admin-account-waiting">
        Your administrator account is set up once the database is running.
      </p>
    );
  }
  if (setupSlow) {
    return (
      <div className="rounded-md border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2" role="status" data-testid="admin-account-slow">
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Setting up your administrator account is taking longer than it should. Check again in a minute; if it
          stays like this, contact support — the platform may need to repair its access to this database.
        </p>
        <button
          type="button"
          onClick={onCheckAgain}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          data-testid="admin-account-check-again"
        >
          <RefreshCw size={14} />
          Check again
        </button>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300" role="status" data-testid="admin-account-pending">
      <Loader2 size={14} className="animate-spin text-blue-500 dark:text-blue-400 shrink-0" aria-hidden="true" />
      Your administrator account is being set up… This takes a few seconds and updates by itself.
    </p>
  );
}

export default function DatabaseAdminAccountCard({
  tenantId,
  deploymentId,
  adminAccount,
  status,
  engine,
  running,
  setupSlow,
  onCheckAgain,
  copiedField,
  onCopy,
}: DatabaseAdminAccountCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotated, setRotated] = useState(false);
  const rotate = useRotateDatabaseAdminPassword(tenantId);

  const openConfirm = useCallback(() => {
    rotate.reset();
    setRotated(false);
    setConfirmOpen(true);
  }, [rotate]);

  const cancelConfirm = useCallback(() => {
    rotate.reset();
    setConfirmOpen(false);
  }, [rotate]);

  const handleRotate = useCallback(() => {
    rotate.mutate(deploymentId, {
      onSuccess: () => {
        setConfirmOpen(false);
        setRotated(true);
        // Shown at once: it is the value every tool now needs.
        setRevealed(true);
      },
    });
  }, [deploymentId, rotate]);

  return (
    <div data-testid="admin-account-card">
      <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
        <ShieldCheck size={14} className="text-blue-600 dark:text-blue-400" />
        Administrator account
      </h4>

      {!adminAccount ? (
        <PendingState status={status} running={running} setupSlow={setupSlow} onCheckAgain={onCheckAgain} />
      ) : (
        <>
          <div className="space-y-3">
            <Row label="Username" testId="admin-account-username">
              <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate select-all">
                {adminAccount.username}
              </span>
              <CopyFieldButton field="admin-username" value={adminAccount.username} copiedField={copiedField} onCopy={onCopy} label="Copy username" />
            </Row>
            <Row label="Password" testId="admin-account-password">
              <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate select-all" data-testid="admin-account-password-value">
                {revealed ? adminAccount.password : MASK}
              </span>
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                title={revealed ? 'Hide password' : 'Show password'}
                aria-label={revealed ? 'Hide password' : 'Show password'}
                aria-pressed={revealed}
                data-testid="toggle-admin-password"
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <CopyFieldButton field="admin-password" value={adminAccount.password} copiedField={copiedField} onCopy={onCopy} label="Copy password" />
            </Row>
          </div>

          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="admin-account-scope">
            {adminAccountScope(engine)}
          </p>

          {rotated && (
            <p className="mt-3 rounded-md border border-green-200 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-3 py-2 text-xs text-green-800 dark:text-green-300" role="status" data-testid="admin-password-rotated">
              New password set. Update every tool and application that logged in with the old one.
            </p>
          )}

          {!confirmOpen ? (
            <button
              type="button"
              onClick={openConfirm}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              data-testid="admin-password-new"
            >
              <RefreshCw size={14} />
              New password
            </button>
          ) : (
            <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3" data-testid="admin-password-confirm">
              <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
                Set a new password for <span className="font-mono font-semibold">{adminAccount.username}</span>? Every tool or
                application that logs in with the current password stops connecting until you update it there.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRotate}
                  disabled={rotate.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="admin-password-confirm-button"
                >
                  {rotate.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Set new password
                </button>
                <button
                  type="button"
                  onClick={cancelConfirm}
                  disabled={rotate.isPending}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                  data-testid="admin-password-cancel"
                >
                  Cancel
                </button>
              </div>
              {rotate.isError && (
                <div className="mt-3">
                  <ErrorPanel
                    error={extractOperatorError(rotate.error)}
                    severity="error"
                    compact
                    testId="admin-password-error"
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
