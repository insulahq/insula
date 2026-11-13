/**
 * Step-up re-authentication: proving the signed-in person is still at the
 * keyboard before something that hands out key material (a DKIM private key,
 * a certificate bundle).
 *
 * The server decides. A gated request answers 403 STEP_UP_REQUIRED with the
 * methods the account has; the panel asks for one, posts it to
 * /me/step-up/{password|passkey}, and repeats the request. The proof lasts the
 * server's freshness window (30 minutes), so a second gated action inside it
 * goes straight through.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import type { StepUpMethod } from '@insula/api-contracts';
import { apiFetch, ApiError } from '@/lib/api-client';

export type { StepUpMethod };

/** The methods a STEP_UP_REQUIRED refusal offers, or null for any other error. */
export function stepUpMethodsOf(err: unknown): readonly StepUpMethod[] | null {
  if (!(err instanceof ApiError) || err.code !== 'STEP_UP_REQUIRED') return null;
  const methods = err.details?.methods;
  return Array.isArray(methods)
    ? methods.filter((m): m is StepUpMethod => m === 'password' || m === 'passkey')
    : [];
}

export async function verifyStepUpPassword(password: string): Promise<void> {
  await apiFetch('/api/v1/me/step-up/password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function verifyStepUpPasskey(): Promise<void> {
  const options = await apiFetch<{ data: unknown }>('/api/v1/me/step-up/passkey/options', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await startAuthentication({ optionsJSON: options.data as any });
  await apiFetch('/api/v1/me/step-up/passkey/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}
