import { z } from 'zod';
import { identityEmailSchema } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: identityEmailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6, 'New password must be at least 6 characters'),
});

export const updateProfileSchema = z.object({
  full_name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
  // IANA timezone string, e.g. "Europe/Berlin". Null clears the user-level
  // override and falls back to the system default on display.
  timezone: z.string().min(1).max(50).nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: z.enum(['super_admin', 'admin', 'billing', 'support', 'read_only', 'tenant_admin', 'tenant_user']),
});

export const loginResponseSchema = z.object({
  data: z.object({
    token: z.string(),
    user: userSchema,
  }),
});

// ─── Passkey (WebAuthn) ──────────────────────────────────────────────────────

// Whether a registered passkey may sign the user in on its own. A passkey is
// already two factors (the device plus its PIN or biometric), so there is no
// password-plus-passkey mode; the second factor for a PASSWORD is TOTP below.
export const passkeyModeSchema = z.union([z.literal('alternative'), z.null()]);
export type PasskeyMode = z.infer<typeof passkeyModeSchema>;

// Per-passkey row returned to the UI. Never exposes credentialId or
// publicKey — the panel only needs display + lifecycle info.
export const passkeySummarySchema = z.object({
  id: z.string(),
  nickname: z.string(),
  aaguid: z.string().nullable(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PasskeySummary = z.infer<typeof passkeySummarySchema>;

export const passkeyRegistrationCompleteSchema = z.object({
  response: z.unknown(), // Browser-issued AttestationResponseJSON; opaque to us.
  nickname: z.string().min(1).max(100),
});
export type PasskeyRegistrationCompleteInput = z.infer<typeof passkeyRegistrationCompleteSchema>;

export const passkeyLoginOptionsRequestSchema = z.object({
  panel: z.union([z.literal('admin'), z.literal('tenant')]).optional(),
});
export type PasskeyLoginOptionsRequest = z.infer<typeof passkeyLoginOptionsRequestSchema>;

export const passkeyLoginVerifyRequestSchema = z.object({
  panel: z.union([z.literal('admin'), z.literal('tenant')]).optional(),
  response: z.unknown(),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof passkeyLoginVerifyRequestSchema>;

export const passkeyModeUpdateSchema = z.object({
  mode: passkeyModeSchema,
});
export type PasskeyModeUpdateInput = z.infer<typeof passkeyModeUpdateSchema>;

// ─── Authenticator-app second factor (TOTP, RFC 6238) ───────────────────────

// Step 1 of a password sign-in for a user with TOTP on: the password was
// right, but instead of session tokens the server returns a short-lived
// single-use pre-auth token. Step 2 is POST /auth/totp/login/verify.
export const loginTotpRequiredResponseSchema = z.object({
  data: z.object({
    requires_totp: z.literal(true),
    pre_auth_token: z.string(),
    expires_in: z.number(),
    user: z.object({
      id: z.string(),
      email: z.string(),
      fullName: z.string(),
      role: z.string(),
      panel: z.string().optional(),
      tenantId: z.string().nullable().optional(),
    }),
  }),
});
export type LoginTotpRequiredResponse = z.infer<typeof loginTotpRequiredResponseSchema>;

/** Six digits from the app (spaces allowed, as apps display them). */
export const totpCodeSchema = z.string().trim().regex(/^\d{3}\s?\d{3}$/, 'Enter the 6-digit code from your authenticator app');
/** A one-time backup code: 10 characters, dashes and spaces ignored. */
export const totpBackupCodeSchema = z.string().trim().min(10).max(16);

/** Either factor proves possession: the live code, or one unused backup code. */
const totpProofSchema = z.object({
  code: totpCodeSchema.optional(),
  backup_code: totpBackupCodeSchema.optional(),
}).strict().refine((v) => (v.code === undefined) !== (v.backup_code === undefined), {
  message: 'Send exactly one of code or backup_code',
});

export const totpLoginVerifySchema = z.object({
  pre_auth_token: z.string().min(1),
  code: totpCodeSchema.optional(),
  backup_code: totpBackupCodeSchema.optional(),
}).strict().refine((v) => (v.code === undefined) !== (v.backup_code === undefined), {
  message: 'Send exactly one of code or backup_code',
});
export type TotpLoginVerifyInput = z.infer<typeof totpLoginVerifySchema>;

export const totpStatusSchema = z.object({
  /** On: a password sign-in also needs a code. */
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  /** Unused backup codes left (0 when TOTP is off). */
  backupCodesRemaining: z.number().int(),
});
export type TotpStatus = z.infer<typeof totpStatusSchema>;

/** Start (or restart) enrolment. The secret is shown ONCE, here. */
export const totpSetupResponseSchema = z.object({
  /** base32, for typing into an app that cannot scan. */
  secret: z.string(),
  /** otpauth:// URI — render as a QR code in the browser, never via a third party. */
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

export const totpEnableSchema = z.object({ code: totpCodeSchema }).strict();
export type TotpEnableInput = z.infer<typeof totpEnableSchema>;

/** Returned when TOTP is turned on and when the codes are regenerated — the only time they are shown. */
export const totpBackupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()),
});
export type TotpBackupCodesResponse = z.infer<typeof totpBackupCodesResponseSchema>;

export const totpDisableSchema = totpProofSchema;
export type TotpDisableInput = z.infer<typeof totpDisableSchema>;
export const totpRegenerateBackupCodesSchema = totpProofSchema;
export type TotpRegenerateBackupCodesInput = z.infer<typeof totpRegenerateBackupCodesSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// `…Request` is the WIRE type (z.input): a `.default(x)` field is optional
// when sending and required in `z.infer`, which is the parsed result. See
// the note in domains.ts for why conflating them produced false errors.
export type ChangePasswordRequest = z.input<typeof changePasswordSchema>;

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateProfileRequest = z.input<typeof updateProfileSchema>;

export type User = z.infer<typeof userSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
