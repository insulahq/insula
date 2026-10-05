/**
 * The sample notification the provider editor previews its email
 * header/footer around.
 *
 * Rendered by the real delivery renderer from the ACTIVE email template of a
 * real category, with the same sample envelope the template preview uses — so
 * the preview carries the real MJML document, including the head CSS (margin
 * resets, `p` spacing) that also styles the operator's header and footer in
 * the delivered message. The admin panel then composes it with
 * `applyEmailChrome`, the function the queue worker sends with.
 *
 * `security.password_changed` because it references only the envelope
 * variables, so the sample shows no "missing value" placeholders.
 */
import type { EmailChromePreviewSampleResponse } from '@insula/api-contracts';
import { getActiveTemplate } from '../templates/service.js';
import { renderForDelivery } from '../templates/render-for-delivery.js';
import { PREVIEW_ENVELOPE_SAMPLE } from '../templates/envelope-vars.js';
import type { Database } from '../../../db/index.js';

export const EMAIL_CHROME_SAMPLE_CATEGORY = 'security.password_changed';

const FALLBACK_TITLE = 'Sample notification';

/** Used only when the sample template has been deleted outright. */
const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;"><div style="margin:0 auto;max-width:600px;font-family:Arial,sans-serif;font-size:14px;line-height:22px;color:#333;padding:20px 25px;"><p style="font-size:20px;font-weight:600;">${FALLBACK_TITLE}</p><p>The body of each notification email appears here, between your header and footer.</p></div></body></html>`;

export async function renderEmailChromePreviewSample(db: Database): Promise<EmailChromePreviewSampleResponse> {
  const template = await getActiveTemplate(db, EMAIL_CHROME_SAMPLE_CATEGORY, 'email', 'en');
  if (!template) return { subject: FALLBACK_TITLE, html: FALLBACK_HTML };
  // Lenient: an operator-edited sample template that no longer renders must
  // not take the header/footer preview down with it.
  const rendered = await renderForDelivery(template, { ...PREVIEW_ENVELOPE_SAMPLE }, { fallbackTitle: FALLBACK_TITLE });
  return { subject: rendered.subject, html: rendered.body };
}
