import { useEffect, useState, type FormEvent } from 'react';
import { Fingerprint, KeyRound, Loader2, X } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { verifyStepUpPasskey, verifyStepUpPassword, type StepUpMethod, type StepUpRefusal } from '@/lib/step-up';

/**
 * "Confirm it is you" — the step-up a gated action asks for.
 *
 * Its own module, loaded with `lazy()` by useStepUpGate, for the reason
 * ChangePasswordModal gives: a password input in the main bundle draws
 * password managers onto every page.
 */

interface StepUpDialogProps {
  /** What is being unlocked, e.g. "the DKIM private key of example.test". */
  readonly what: string;
  /** The server's STEP_UP_REQUIRED refusal: methods, window, whose credential. */
  readonly refusal: StepUpRefusal;
  readonly onVerified: () => void;
  readonly onCancel: () => void;
}

/** "5 minutes", "30 minutes", "1 minute"; null when the server named no window. */
function windowText(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function messageOf(err: unknown, canPasskey: boolean): string {
  if (err instanceof ApiError && err.code === 'STEP_UP_FAILED') return 'That did not match. Try again.';
  if (err instanceof ApiError && err.code === 'STEP_UP_LOCKED') {
    // Locked per person after too many wrong passwords; the server says for how long.
    const seconds = typeof err.details?.retry_after === 'number' ? err.details.retry_after : null;
    const when = seconds === null
      ? 'later'
      : `at ${new Date(Date.now() + seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in about ${Math.max(1, Math.ceil(seconds / 60))} min)`;
    return `Password confirmation is locked after too many wrong passwords. It unlocks ${when}.${canPasskey ? ' A passkey still works.' : ''}`;
  }
  if (err instanceof Error && err.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out.';
  return err instanceof Error ? err.message : 'Could not confirm it is you.';
}

export default function StepUpDialog({ what, refusal, onVerified, onCancel }: StepUpDialogProps) {
  const { methods, impersonation, credentialEmail } = refusal;
  const lasts = windowText(refusal.maxAgeSeconds);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<StepUpMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPassword = methods.includes('password');
  const canPasskey = methods.includes('passkey');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && busy === null) onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function verify(method: StepUpMethod, run: () => Promise<void>) {
    setBusy(method);
    setError(null);
    try {
      await run();
      setPassword('');
      onVerified();
    } catch (err) {
      setError(messageOf(err, canPasskey));
    } finally {
      setBusy(null);
    }
  }

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (password.length === 0 || busy !== null) return;
    void verify('password', () => verifyStepUpPassword(password));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      data-testid="step-up-dialog"
      onClick={(e) => { if (e.target === e.currentTarget && busy === null) onCancel(); }}
    >
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 id="step-up-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Confirm it is you
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy !== null}
            className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="step-up-explainer">
            You are about to see {what}. Confirm it is you to continue
            {lasts ? `; it then stays unlocked for ${lasts}, in this browser session only.` : '.'}
          </p>

          {impersonation && (
            <p
              className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
              data-testid="step-up-impersonation"
            >
              You are signed in as this tenant from your staff account
              {credentialEmail ? <> (<span className="font-medium">{credentialEmail}</span>)</> : null}.
              Confirm with <strong>your own</strong> staff password or passkey, not the tenant&apos;s.
            </p>
          )}

          {canPassword && (
            <form onSubmit={submitPassword} className="space-y-2">
              <label htmlFor="step-up-password" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                {impersonation ? 'Your staff password' : 'Password'}
              </label>
              <input
                id="step-up-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT_CLASS}
                data-testid="step-up-password"
              />
              <button
                type="submit"
                disabled={password.length === 0 || busy !== null}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="step-up-password-submit"
              >
                {busy === 'password' ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                Confirm with password
              </button>
            </form>
          )}

          {canPasskey && (
            <div>
              {canPassword && <p className="mb-2 text-center text-xs text-gray-500 dark:text-gray-400">or</p>}
              <button
                type="button"
                onClick={() => void verify('passkey', verifyStepUpPasskey)}
                disabled={busy !== null}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                data-testid="step-up-passkey"
              >
                {busy === 'passkey' ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
                {impersonation ? 'Confirm with your staff passkey' : 'Confirm with passkey'}
              </button>
            </div>
          )}

          {!canPassword && !canPasskey && (
            <p className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-200" data-testid="step-up-no-method">
              {impersonation
                ? 'Your staff account has no password or passkey to confirm with. Register a passkey and turn on passkey sign-in under User settings in the admin panel, then try again.'
                : 'Your account has no password or passkey to confirm with. Register a passkey and turn on passkey sign-in under User settings, then try again.'}
            </p>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="step-up-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
