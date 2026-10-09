/**
 * Second step of a password sign-in for a user with an authenticator app on:
 * the 6-digit code, or — for someone without their phone — one backup code.
 * The auth store holds the pre-auth token and does the request; a wrong code
 * keeps this step (retype it), an expired step drops back to the password.
 */
import { useState, type FormEvent } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

interface TotpStepProps {
  readonly email: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

const INPUT = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100';

export default function TotpStep({ email, onDone, onCancel }: TotpStepProps) {
  const { verifyTotp, error, isLoading } = useAuth();
  const [useBackup, setUseBackup] = useState(false);
  const [value, setValue] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await verifyTotp(useBackup ? { backupCode: value } : { code: value });
      onDone();
    } catch {
      setValue('');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="totp-step">
      <div className="flex gap-2 rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-900 dark:text-blue-100">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" />
        <span>
          {useBackup
            ? <>Enter one of your backup codes for <strong>{email}</strong>. Each code works once.</>
            : <>Enter the 6-digit code from your authenticator app for <strong>{email}</strong>.</>}
        </span>
      </div>
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="totp-error">{error}</div>
      )}
      <div>
        <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {useBackup ? 'Backup code' : 'Authentication code'}
        </label>
        <input
          id="totp-code"
          key={useBackup ? 'backup' : 'code'}
          type="text"
          required
          autoFocus
          autoComplete={useBackup ? 'off' : 'one-time-code'}
          inputMode={useBackup ? 'text' : 'numeric'}
          pattern={useBackup ? undefined : '[0-9 ]{6,7}'}
          maxLength={useBackup ? 16 : 7}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${INPUT} font-mono tracking-widest`}
          placeholder={useBackup ? 'XXXXX-XXXXX' : '123 456'}
          data-testid="totp-code-input"
        />
      </div>
      <button type="submit" disabled={isLoading || value.trim() === ''} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="totp-submit">
        {isLoading && <Loader2 size={16} className="animate-spin" />} Verify
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => { setUseBackup((b) => !b); setValue(''); }} className="text-brand-600 hover:underline dark:text-brand-400" data-testid="totp-toggle-backup">
          {useBackup ? 'Use the authenticator app' : 'Use a backup code'}
        </button>
        <button type="button" onClick={onCancel} className="text-gray-500 hover:underline dark:text-gray-400" data-testid="totp-cancel">
          Back to sign-in
        </button>
      </div>
    </form>
  );
}
