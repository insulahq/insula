import { z } from 'zod';

// ─── Step-up re-authentication for privileged operations ────────────
//
// A "step-up" is a fresh credential challenge required when the user
// hasn't proven a credential recently enough for a privileged action
// (e.g. opening a root shell on a cluster node). Freshness belongs to the
// SESSION that stepped up (auth_step_ups, keyed by the access token's `sid`):
// another session of the same user is asked again. Windows: 30 minutes for
// the node terminal, 5 minutes for key material (dkim_private_key,
// cert_download). Signing in does not count as a step-up.
//
// Under "Login as tenant" the staff member confirms with THEIR OWN password
// or passkey; the refusal says so (`impersonation`, `credentialEmail`).
// API tokens need no step-up: their scopes bind instead.
//
// Methods are derived from the user's auth config:
//   • 'password'  — user has a passwordHash set
//   • 'passkey'   — user has passkey_mode = 'alternative' (passkey sign-in on)
//
// Multi-method users (passwordHash AND passkey enabled) MUST pass
// every applicable method to satisfy step-up; the backend returns the
// list and the frontend collects them in sequence.

export const stepUpMethodSchema = z.union([
  z.literal('password'),
  z.literal('passkey'),
]);
export type StepUpMethod = z.infer<typeof stepUpMethodSchema>;

// Purposes pick the freshness window (one per-session clock, read against
// the purpose's window: 30 minutes for node_terminal, 5 for the others).
//   node_terminal     root shell on a cluster node (admin panel)
//   dkim_private_key  showing an email domain's DKIM signing key
//   cert_download     a domain's certificate + private key, and minting a
//                     token that can fetch them unattended
export const stepUpPurposeSchema = z.union([
  z.literal('node_terminal'),
  z.literal('dkim_private_key'),
  z.literal('cert_download'),
]);
export type StepUpPurpose = z.infer<typeof stepUpPurposeSchema>;

// ─── Status (GET /me/step-up/status?purpose=node_terminal) ─────────

export const stepUpStatusQuerySchema = z.object({
  purpose: stepUpPurposeSchema,
});
export type StepUpStatusQuery = z.infer<typeof stepUpStatusQuerySchema>;

export const stepUpStatusResponseSchema = z.object({
  data: z.object({
    required: z.boolean(),
    methods: z.array(stepUpMethodSchema),
    lastCredentialCheckAt: z.string().datetime().nullable(),
    maxAgeSeconds: z.number().int().positive(),
    /** True under "Login as tenant": the credential asked for is the staff member's own. */
    impersonation: z.boolean().optional(),
    /** Whose credential is asked for, when it is not the signed-in account's (impersonation). */
    credentialEmail: z.string().nullable().optional(),
  }),
});
export type StepUpStatusResponse = z.infer<typeof stepUpStatusResponseSchema>;

/**
 * `details` of a 403 STEP_UP_REQUIRED refusal. The panel asks for one of
 * `methods`, posts it to /me/step-up/*, and repeats the refused request.
 */
export const stepUpRequiredDetailsSchema = z.object({
  purpose: stepUpPurposeSchema.optional(),
  methods: z.array(stepUpMethodSchema),
  lastCredentialCheckAt: z.string().nullable().optional(),
  maxAgeSeconds: z.number().int().positive().optional(),
  impersonation: z.boolean().optional(),
  credentialEmail: z.string().nullable().optional(),
});
export type StepUpRequiredDetails = z.infer<typeof stepUpRequiredDetailsSchema>;

// ─── Password step-up (POST /me/step-up/password) ──────────────────

export const stepUpPasswordRequestSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
export type StepUpPasswordRequest = z.infer<typeof stepUpPasswordRequestSchema>;

// ─── Passkey step-up (POST /me/step-up/passkey/options + /verify) ─

// Begin: server returns the WebAuthn challenge bound to this user.
export const stepUpPasskeyOptionsResponseSchema = z.object({
  data: z.unknown(), // Server-issued PublicKeyCredentialRequestOptionsJSON
});
export type StepUpPasskeyOptionsResponse = z.infer<typeof stepUpPasskeyOptionsResponseSchema>;

// Verify: client returns the AuthenticationResponseJSON.
export const stepUpPasskeyVerifyRequestSchema = z.object({
  response: z.unknown(),
});
export type StepUpPasskeyVerifyRequest = z.infer<typeof stepUpPasskeyVerifyRequestSchema>;

// ─── Shared success response ───────────────────────────────────────

export const stepUpSuccessResponseSchema = z.object({
  data: z.object({
    ok: z.literal(true),
    methodVerified: stepUpMethodSchema,
    lastCredentialCheckAt: z.string().datetime(),
  }),
});
export type StepUpSuccessResponse = z.infer<typeof stepUpSuccessResponseSchema>;
