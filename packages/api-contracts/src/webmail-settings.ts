import { z } from 'zod';
import { webmailEngineSchema } from './mailboxes.js';

// RFC-1123 DNS hostname, shared by the URL-host check below and the
// mailServerHostname field. Dot-separated labels, ≥2 labels (FQDN).
const DNS_HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Accept an http(s) URL with a valid DNS hostname. We don't force a
// particular TLD so corporate intranets can use internal FQDNs, but the
// host MUST be a clean DNS name: the webmail-router reconciler interpolates
// it into a Traefik `Host(`<host>`)` match rule AND the stalwart-jmap-cors
// Access-Control-Allow-Origin, so a crafted value with backticks/parens
// (match-rule injection) must be rejected here. The reconciler
// (resolveWebmailHostOrigin) re-validates as defence-in-depth.
const webmailUrlSchema = z
  .string()
  .min(1)
  .max(255)
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        DNS_HOSTNAME_RE.test(u.hostname)
      );
    } catch {
      return false;
    }
  }, 'must be an http(s) URL with a valid DNS hostname');

export const updateWebmailSettingsSchema = z.object({
  defaultWebmailUrl: webmailUrlSchema.optional(),
  // Phase 3.A.1: the platform-wide mail server hostname Stalwart
  // advertises on SMTP/IMAP banners and in its TLS certificate.
  // All customer `mail.<domain>` records CNAME to this hostname.
  mailServerHostname: z
    .string()
    .trim()
    .min(1)
    .max(253)
    // RFC-1123 DNS hostname. This value is interpolated into a Traefik
    // match rule `Host(`<host>`) && …` by the mail-acme-override-route
    // reconciler, so it MUST be constrained here so a crafted value with
    // backticks/parentheses can never reach the reconciler (match-rule
    // injection). See backend/src/modules/mail-admin/mail-acme-override-route.ts.
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i,
      'must be a valid DNS hostname',
    )
    .optional(),
  // Phase 3.B.3: global default per-customer email send rate limit
  // (messages per hour). null = no default (Stalwart uses its built-in
  // defaults). 0 = all customers blocked unless an override allows.
  emailSendRateLimitDefault: z.number().int().min(0).max(1000000).nullable().optional(),
  // ADR-039 Phase 10: which webmail UI the platform mints handoff
  // tokens for. The backend already maps `roundcube` → `?_task=login&_jwt=`
  // and `bulwark` → `/_impersonate?token=` in generateWebmailToken.
  defaultWebmailEngine: webmailEngineSchema.optional(),
  // 2026-05-18: Webmail feature visibility — three independent flags
  // that hide the matching tab/icon in the webmail UI via CSS. The
  // underlying Stalwart DAV endpoints stay reachable (DAV clients
  // like Thunderbird and iOS continue working) — this is UI-only.
  // All default to false (hidden) so the fresh-install experience
  // is mail-only.
  webmailShowContacts: z.boolean().optional(),
  webmailShowCalendar: z.boolean().optional(),
  webmailShowFiles: z.boolean().optional(),
});

export type UpdateWebmailSettingsInput = z.infer<typeof updateWebmailSettingsSchema>;

export const webmailSettingsResponseSchema = z.object({
  defaultWebmailUrl: z.string(),
  mailServerHostname: z.string().optional(),
  emailSendRateLimitDefault: z.number().nullable().optional(),
  defaultWebmailEngine: webmailEngineSchema,
  // 2026-05-18 (see updateWebmailSettingsSchema). Always present in
  // the response so the admin UI can render the toggle state
  // deterministically; backend coerces unset keys to false.
  webmailShowContacts: z.boolean(),
  webmailShowCalendar: z.boolean(),
  webmailShowFiles: z.boolean(),
});

export type WebmailSettingsResponse = z.infer<typeof webmailSettingsResponseSchema>;
