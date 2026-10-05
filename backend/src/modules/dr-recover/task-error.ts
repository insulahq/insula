/**
 * Turn whatever stopped a background tenant recovery into the `OperatorError`
 * its progress modal renders through `<ErrorPanel>`.
 *
 * Exposure matches the synchronous route exactly: an `ApiError` is shown as
 * the route would answer it (code, message, remediation, details); an error
 * the operator-error catalog recognises is translated the way the error
 * handler translates it; anything else is NOT shown raw — upstream messages
 * can carry hostnames, bucket paths or credential context, which is why the
 * error handler answers them with a generic 500. The raw error goes to the log.
 */

import type { OperatorError } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { translateOperatorError } from '../../shared/operator-error.js';

const DEFAULT_REMEDIATION = 'Fix the cause above, then start the recovery again.';

export function toRecoverOperatorError(err: unknown, stepLabel: string | null): OperatorError {
  const where = stepLabel ? ` at “${stepLabel}”` : '';
  if (err instanceof ApiError) {
    const { operatorError: embedded, ...diagnostics } = (err.details ?? {}) as Record<string, unknown> & {
      operatorError?: OperatorError;
    };
    if (embedded) return embedded;
    return {
      code: err.code,
      title: `Recovery failed${where}`,
      detail: err.message,
      remediation: [err.remediation ?? DEFAULT_REMEDIATION],
      retryable: true,
      diagnostics: { code: err.code, status: err.status, ...diagnostics },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const translated = translateOperatorError(message);
  if (translated.code !== 'UNKNOWN') return translated;
  return {
    code: 'DR_RECOVER_FAILED',
    title: `Recovery failed${where}`,
    detail: 'An unexpected error stopped the recovery. The full error is in the platform-api log.',
    remediation: [
      'Look up the error in the platform-api log at the time the step failed.',
      DEFAULT_REMEDIATION,
    ],
    retryable: true,
  };
}

/** A restore cart that ran to the end but stopped at a failed item. */
export function restoreFailedError(args: {
  readonly stepLabel: string;
  readonly cartId: string;
  readonly bundleId: string;
  /** `restore_jobs.last_error` — already sanitised by the cart executor. */
  readonly lastError: string | null;
}): OperatorError {
  return {
    code: 'DR_RESTORE_FAILED',
    title: `Recovery failed at “${args.stepLabel}”`,
    detail: args.lastError
      ? `The restore stopped at a failed item — ${args.lastError}.`
      : 'The restore stopped at a failed item.',
    remediation: [
      'The failed item and its error are listed under Restore items.',
      'Fix the cause, then start the recovery again — it builds a new restore and applies every item again.',
    ],
    retryable: true,
    diagnostics: { cartId: args.cartId, bundleId: args.bundleId },
  };
}
