import { z } from 'zod';

/**
 * Mail-client connection settings surfaced to tenants.
 *
 * The port/security table below is the SINGLE SOURCE OF TRUTH for what we tell
 * users to type into their mail client. `email-autodiscover/templates.ts`
 * renders the same numbers into the Mozilla autoconfig and Outlook
 * autodiscover XML, and the tenant panel's "How to connect" guide reads them
 * from here — so a change lands in every surface at once instead of drifting
 * between the XML a client auto-fetches and the instructions a human follows.
 */

export const MAIL_SOCKET_TYPES = ['ssl', 'starttls'] as const;
export type MailSocketType = (typeof MAIL_SOCKET_TYPES)[number];

export interface MailServicePort {
  /** Protocol as a user sees it in a mail client's account setup. */
  readonly protocol: 'imap' | 'pop3' | 'smtp';
  readonly port: number;
  readonly socketType: MailSocketType;
  /** true when this is the entry we recommend first for that protocol. */
  readonly recommended: boolean;
}

export const MAIL_SERVICE_PORTS: readonly MailServicePort[] = [
  { protocol: 'imap', port: 993, socketType: 'ssl', recommended: true },
  { protocol: 'imap', port: 143, socketType: 'starttls', recommended: false },
  { protocol: 'pop3', port: 995, socketType: 'ssl', recommended: true },
  { protocol: 'smtp', port: 465, socketType: 'ssl', recommended: true },
  { protocol: 'smtp', port: 587, socketType: 'starttls', recommended: false },
];

/** Convenience lookup for the recommended port of a protocol. */
export function recommendedMailPort(protocol: MailServicePort['protocol']): MailServicePort {
  const match = MAIL_SERVICE_PORTS.find((p) => p.protocol === protocol && p.recommended);
  if (!match) throw new Error(`no recommended port registered for ${protocol}`);
  return match;
}

const mailServicePortSchema = z.object({
  protocol: z.enum(['imap', 'pop3', 'smtp']),
  port: z.number().int().positive(),
  socketType: z.enum(MAIL_SOCKET_TYPES),
  recommended: z.boolean(),
});

export const emailConnectionInfoSchema = z.object({
  /** The domain these settings are for, e.g. `example.test`. */
  domainName: z.string(),
  /**
   * Hostname to enter as both incoming and outgoing server. Platform-wide
   * (`platform_settings.mail_server_hostname`), NOT per-tenant — every
   * customer domain points its MX here and the cert covers this name.
   */
  mailServerHostname: z.string(),
  ports: z.array(mailServicePortSchema),
  /**
   * Where a user can reach webmail directly, without signing in to the
   * tenant panel first. Null when the operator has not configured one.
   */
  webmailUrl: z.string().nullable(),
  /**
   * Per-domain vanity webmail host (`webmail.<domain>`), present only when the
   * tenant enabled it for this domain. Defaults off — most tenants use the
   * platform-wide `webmailUrl`.
   */
  webmailHostname: z.string().nullable(),
});

export type EmailConnectionInfo = z.infer<typeof emailConnectionInfoSchema>;
