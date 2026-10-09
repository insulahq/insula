/**
 * A user's authenticator-app status in a user table, with the super_admin's
 * "Reset" for someone who lost both the phone and the backup codes. Clicks do
 * not reach the row (tenant-user rows navigate on click).
 */
import { useState, type MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useAuth } from '@/hooks/use-auth';
import { useResetUserTotp } from '@/hooks/use-admin-users';

interface TotpResetCellProps {
  readonly userId: string;
  readonly enabled: boolean;
}

export default function TotpResetCell({ userId, enabled }: TotpResetCellProps) {
  const isSuperAdmin = useAuth((s) => s.user?.role === 'super_admin');
  const reset = useResetUserTotp();
  const [confirming, setConfirming] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();

  if (!enabled) {
    return <span className="text-xs text-gray-400 dark:text-gray-500" data-testid={`totp-off-${userId}`}>—</span>;
  }
  return (
    <div className="inline-flex flex-col items-start gap-1" onClick={stop}>
      <span className="inline-flex items-center gap-2">
        <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300" title="Password sign-in needs an authenticator-app code" data-testid={`totp-on-${userId}`}>
          App code
        </span>
        {isSuperAdmin && !confirming && (
          <button type="button" onClick={() => setConfirming(true)} className="text-xs text-red-600 hover:underline dark:text-red-400" data-testid={`totp-reset-${userId}`}>
            Reset
          </button>
        )}
        {isSuperAdmin && confirming && (
          <>
            <button type="button" disabled={reset.isPending} onClick={() => reset.mutate(userId, { onSuccess: () => setConfirming(false) })}
              className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`totp-reset-confirm-${userId}`}>
              {reset.isPending && <Loader2 size={12} className="animate-spin" />} Remove app code
            </button>
            <button type="button" onClick={() => { setConfirming(false); reset.reset(); }} className="text-xs text-gray-500 hover:underline dark:text-gray-400">Cancel</button>
          </>
        )}
      </span>
      {reset.error && <ErrorPanel error={extractOperatorError(reset.error)} compact />}
    </div>
  );
}
