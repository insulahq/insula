/**
 * Stalwart master-account SMTP sender.
 *
 * Used by smtp_relay_configs rows where provider_type='stalwart-internal'.
 * The relay row carries an auth_username that authenticates as the
 * Stalwart System Administrator (`master@<apex>`); the broker accepts
 * arbitrary From: headers from that login so a single relay can send
 * for noreply@, postmaster@, abuse@, etc. without provisioning a
 * mailbox per address.
 *
 * The auth password is stored encrypted in
 * `smtp_relay_configs.auth_password_encrypted` (the same plaintext as
 * the `stalwart-admin-creds` K8s Secret in the `mail` namespace). At
 * send time we decrypt with PLATFORM_ENCRYPTION_KEY and pass to
 * nodemailer.
 */
import nodemailer from 'nodemailer';
import { decrypt } from '../../oidc/crypto.js';

export interface StalwartMasterRelay {
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly authUsername: string | null;
  readonly authPasswordEncrypted: string | null;
  readonly fromAddress: string | null;
}

export interface SendViaStalwartMasterInput {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly plainText?: string;
}

export interface SendResult {
  readonly providerMessageId?: string;
}

export async function sendViaStalwartMaster(
  relay: StalwartMasterRelay,
  input: SendViaStalwartMasterInput,
  encryptionKey: string,
): Promise<SendResult> {
  if (!relay.smtpHost) throw new Error('stalwart-internal relay missing smtpHost');
  if (!relay.authUsername) throw new Error('stalwart-internal relay missing authUsername');
  if (!relay.authPasswordEncrypted) throw new Error('stalwart-internal relay missing authPasswordEncrypted');

  const password = decrypt(relay.authPasswordEncrypted, encryptionKey);

  const port = relay.smtpPort ?? 587;
  const transport = nodemailer.createTransport({
    host: relay.smtpHost,
    port,
    secure: port === 465,
    auth: { user: relay.authUsername, pass: password },
  });

  const fromHeader = relay.fromAddress
    ? `Hosting Platform <${relay.fromAddress}>`
    : `Hosting Platform <${relay.authUsername}>`;

  const result = await transport.sendMail({
    from: fromHeader,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.plainText,
  });

  return { providerMessageId: result.messageId };
}
