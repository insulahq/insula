/**
 * Step-up re-authentication: proving the signed-in person is still at the
 * keyboard before something that hands out key material (a DKIM private key,
 * a certificate bundle).
 *
 * The server decides. A gated request answers 403 STEP_UP_REQUIRED with the
 * methods the credential holder has; the panel asks for one, posts it to
 * /me/step-up/{password|passkey}, and repeats the request. The proof belongs
 * to this browser session only and lasts the window the refusal names (5
 * minutes for key material), so a second gated action inside it goes
 * straight through. Under "Login as tenant" the credential asked for is the
 * staff member's own (`impersonation`, `credentialEmail`).
 */
import { startAuthentication } from '@simplewebauthn/browser';
import type { StepUpMethod } from '@insula/api-contracts';
import { apiFetch, ApiError } from '@/lib/api-client';

export type { StepUpMethod };

/** What a STEP_UP_REQUIRED refusal asks for. */
export interface StepUpRefusal {
  readonly methods: readonly StepUpMethod[];
  /** How long the step-up then lasts, in seconds; null when the server did not say. */
  readonly maxAgeSeconds: number | null;
  /** True under "Login as tenant": confirm with your own staff credential. */
  readonly impersonation: boolean;
  /** Whose credential is asked for, under impersonation. */
  readonly credentialEmail: string | null;
}

/** The refusal's details, or null for any error that is not STEP_UP_REQUIRED. */
export function stepUpRefusalOf(err: unknown): StepUpRefusal | null {
  if (!(err instanceof ApiError) || err.code !== 'STEP_UP_REQUIRED') return null;
  const d = (err.details ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(d.methods)
    ? d.methods.filter((m): m is StepUpMethod => m === 'password' || m === 'passkey')
    : [];
  return {
    methods,
    maxAgeSeconds: typeof d.maxAgeSeconds === 'number' && d.maxAgeSeconds > 0 ? d.maxAgeSeconds : null,
    impersonation: d.impersonation === true,
    credentialEmail: typeof d.credentialEmail === 'string' ? d.credentialEmail : null,
  };
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
