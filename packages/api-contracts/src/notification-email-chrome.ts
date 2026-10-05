/**
 * Email header and footer ("chrome") for platform notification emails.
 *
 * Each email notification provider carries an operator-authored header and
 * footer, as HTML, that wrap every notification email it sends. Both default
 * to empty, and empty means the email is byte-for-byte what it was before the
 * feature existed — `applyEmailChrome` returns its input untouched.
 *
 * Shared by the backend send path (queue worker, provider test email) and the
 * admin panel's live preview, so the preview is composed by the same function
 * as the real message rather than by a look-alike.
 *
 * The HTML is inserted VERBATIM. Template variables (`{{userName}}`, …) are
 * deliberately not interpolated: the header/footer is static branding and
 * legal text, and running it through the strict Handlebars renderer would add
 * a second way for a notification to fail to render — for every category at
 * once. `{{` therefore appears literally, and the preview shows exactly that.
 *
 * `emailChromeProblem` is a guard rail for a trusted, admin-only field, not an
 * HTML sanitiser: it refuses what would break the email the fragment is
 * inserted into (document-level tags, a comment or <style> left open) and the
 * active content every mail client strips anyway (scripts, event handlers,
 * javascript: URLs, embedded frames), so the operator learns at save time
 * instead of from a recipient.
 */
import { z } from 'zod';

/** Cap per block, in UTF-8 bytes. A logo row plus a legal footer is ~2 KB. */
export const EMAIL_CHROME_MAX_BYTES = 20 * 1024;

/**
 * Each block sits in a centred column the width of the email body: every
 * seeded template is MJML, whose body column is 600px. Without it, a plain
 * `<p>` header hugs the left edge of a wide mail window while the body below
 * it is centred.
 */
const BLOCK_OPEN = '<div style="margin:0 auto;max-width:600px;">';
const BLOCK_CLOSE = '</div>';

export interface EmailChrome {
  readonly headerHtml?: string | null;
  readonly footerHtml?: string | null;
}

function isBlank(html: string | null | undefined): boolean {
  return !html || html.trim().length === 0;
}

/** True when either the header or the footer has content. */
export function hasEmailChrome(chrome: EmailChrome): boolean {
  return !isBlank(chrome.headerHtml) || !isBlank(chrome.footerHtml);
}

function block(html: string | null | undefined): string {
  return isBlank(html) ? '' : `${BLOCK_OPEN}${html}${BLOCK_CLOSE}`;
}

/**
 * Wrap an email's HTML part in the header and footer.
 *
 * A full document (what MJML emits) gets the header straight after `<body …>`
 * and the footer straight before the last `</body>`; a fragment with no
 * `<body>` is simply surrounded. Empty chrome returns `html` unchanged.
 */
export function applyEmailChrome(html: string, chrome: EmailChrome): string {
  const header = block(chrome.headerHtml);
  const footer = block(chrome.footerHtml);
  if (!header && !footer) return html;

  const bodyOpen = /<body(?=[\s>])[^>]*>/i.exec(html);
  if (!bodyOpen) return `${header}${html}${footer}`;

  const insertAt = bodyOpen.index + bodyOpen[0].length;
  let closeAt = -1;
  const closeRe = /<\/body\s*>/gi;
  for (let m = closeRe.exec(html); m; m = closeRe.exec(html)) closeAt = m.index;
  const tailAt = closeAt >= insertAt ? closeAt : html.length;

  return html.slice(0, insertAt) + header + html.slice(insertAt, tailAt) + footer + html.slice(tailAt);
}

/** UTF-8 encoded length, without TextEncoder (this package targets no DOM lib). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const FORBIDDEN_TAGS: Readonly<Record<string, string>> = {
  script: 'active content is not allowed in email',
  iframe: 'active content is not allowed in email',
  frame: 'active content is not allowed in email',
  frameset: 'active content is not allowed in email',
  object: 'active content is not allowed in email',
  embed: 'active content is not allowed in email',
  applet: 'active content is not allowed in email',
  form: 'mail clients flag forms as phishing',
  base: 'it would rewrite every link in the email',
  meta: 'the header and footer are fragments inside the email body',
  link: 'the header and footer are fragments inside the email body',
  html: 'the header and footer are fragments inside the email body',
  head: 'the header and footer are fragments inside the email body',
  body: 'the header and footer are fragments inside the email body',
  title: 'the header and footer are fragments inside the email body',
  textarea: 'it would swallow the email body that follows',
  xmp: 'it would swallow the email body that follows',
  plaintext: 'it would swallow the email body that follows',
  noscript: 'it would swallow the email body that follows',
};

const FORBIDDEN_TAG_RE = new RegExp(
  `<\\/?\\s*(${Object.keys(FORBIDDEN_TAGS).join('|')})(?=[\\s/>]|$)`,
  'i',
);
/** An `on…=` attribute inside a tag: `<img onerror=…>`, `<svg/onload=…>`. */
const EVENT_HANDLER_RE = /<[a-z][^>]*?[\s"'/]on[a-z]+\s*=/i;
/** An attribute value that starts with a script scheme. */
const SCRIPT_URL_RE = /=\s*["']?\s*(?:javascript|vbscript):/i;

function countMatches(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length;
}

/**
 * Why `html` cannot be used as an email header/footer, or null when it can.
 * Phrased to follow "HTML …" in a validation message.
 */
export function emailChromeProblem(html: string): string | null {
  if (utf8ByteLength(html) > EMAIL_CHROME_MAX_BYTES) {
    return `must be at most ${EMAIL_CHROME_MAX_BYTES / 1024} KB`;
  }
  const tag = FORBIDDEN_TAG_RE.exec(html);
  if (tag) {
    const name = tag[1].toLowerCase();
    return `must not contain <${name}> tags (${FORBIDDEN_TAGS[name]})`;
  }
  if (/<!doctype/i.test(html)) {
    return 'must not contain a <!DOCTYPE> (the header and footer are fragments inside the email body)';
  }
  if (EVENT_HANDLER_RE.test(html)) {
    return 'must not contain event-handler attributes such as onclick= or onerror=';
  }
  if (SCRIPT_URL_RE.test(html)) {
    return 'must not contain javascript: or vbscript: URLs';
  }
  const lastCommentOpen = html.lastIndexOf('<!--');
  if (lastCommentOpen !== -1 && html.indexOf('-->', lastCommentOpen + 4) === -1) {
    return 'must not leave an <!-- comment open (it would hide the rest of the email)';
  }
  if (countMatches(/<style(?=[\s>])/gi, html) > countMatches(/<\/style\s*>/gi, html)) {
    return 'must close every <style> element (an open one swallows the email body as CSS)';
  }
  return null;
}

/** Zod schema for one header/footer block. Empty string = no block. */
export const emailChromeHtmlSchema = z.string().superRefine((html, ctx) => {
  const problem = emailChromeProblem(html);
  if (problem) ctx.addIssue({ code: 'custom', message: `HTML ${problem}` });
});

/**
 * A real notification, rendered by the real template renderer with sample
 * values, for the provider editor's live preview. The admin panel wraps it
 * with `applyEmailChrome` on every keystroke.
 */
export const emailChromePreviewSampleResponseSchema = z.object({
  subject: z.string().nullable(),
  html: z.string(),
});
export type EmailChromePreviewSampleResponse = z.infer<typeof emailChromePreviewSampleResponseSchema>;
