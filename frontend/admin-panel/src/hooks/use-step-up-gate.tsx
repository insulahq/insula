import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { stepUpRefusalOf, type StepUpRefusal } from '@/lib/step-up';

const StepUpDialog = lazy(() => import('@/components/StepUpDialog'));

interface Pending {
  readonly refusal: StepUpRefusal;
  readonly settle: (stepped: boolean) => void;
}

/**
 * Run an action the server may refuse with STEP_UP_REQUIRED: on that refusal,
 * ask the person to confirm it is them, then run the action again.
 *
 *   const gate = useStepUpGate('the private key');
 *   const key = await gate.run(() => fetchKey());   // undefined if cancelled
 *   …
 *   return <>{…}{gate.dialog}</>;
 *
 * Any other error, including STEP_UP_UNAVAILABLE (an account with nothing to
 * step up with), reaches the caller unchanged, so it is shown where the action
 * reports its errors.
 */
export function useStepUpGate(what: string) {
  const [pending, setPending] = useState<Pending | null>(null);
  const busy = useRef(false);
  const open = useRef<Pending | null>(null);
  // Leaving the page with the dialog open counts as cancelling, so the
  // waiting action finishes instead of hanging.
  useEffect(() => () => open.current?.settle(false), []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (err) {
      const refusal = stepUpRefusalOf(err);
      if (refusal === null || busy.current) throw err;
      busy.current = true;
      const stepped = await new Promise<boolean>((settle) => {
        open.current = { refusal, settle };
        setPending(open.current);
      });
      open.current = null;
      busy.current = false;
      setPending(null);
      if (!stepped) return undefined;
      return action();
    }
  }, []);

  const dialog: ReactNode = pending ? (
    <Suspense fallback={null}>
      <StepUpDialog
        what={what}
        refusal={pending.refusal}
        onVerified={() => pending.settle(true)}
        onCancel={() => pending.settle(false)}
      />
    </Suspense>
  ) : null;

  return { run, dialog, asking: pending !== null };
}
