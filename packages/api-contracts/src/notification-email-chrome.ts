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
 * `emailChromeProblem` refuses what would break the email the fragment is
 * inserted into (document-level tags; a comment, tag, quote or <style> left
 * open) and active content (scripts, frames, event handlers, javascript:/
 * vbscript: URLs, data: URLs other than an inline raster logo, CSS
 * expression()), so the operator learns at save time instead of from a
 * recipient. It reads the markup with a tokenizer that follows the browser's
 * (email-html-scan.ts) and decodes character references before judging a
 * value — `&#106;avascript:` and `java&Tab;script:` are `javascript:`. It is
 * one rule for both the editor and the API, and it rejects rather than
 * strips: a header that silently loses half its markup is a worse surprise
 * than a clear error.
 */
import { z } from 'zod';
import { decodeCharRefs, scanHtml, type ScanIssue, type ScannedAttr } from './email-html-scan.js';

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

const ACTIVE = 'active content is not allowed in email';
const FRAGMENT = 'the header and footer are fragments inside the email body';
const SWALLOWS = 'it would swallow the email body that follows';

const FORBIDDEN_TAGS: Readonly<Record<string, string>> = {
  script: ACTIVE, iframe: ACTIVE, frame: ACTIVE, frameset: ACTIVE,
  object: ACTIVE, embed: ACTIVE, applet: ACTIVE,
  // Foreign content: <style> is not raw text there and CDATA exists, so the
  // scanner cannot vouch for it — and mail clients drop inline SVG anyway.
  svg: 'inline SVG can carry script and most mail clients drop it — use <img> with a PNG',
  math: 'MathML is not supported in email',
  form: 'mail clients flag forms as phishing',
  base: 'it would rewrite every link in the email',
  meta: FRAGMENT, link: FRAGMENT, html: FRAGMENT, head: FRAGMENT, body: FRAGMENT, title: FRAGMENT,
  textarea: SWALLOWS, xmp: SWALLOWS, plaintext: SWALLOWS, noscript: SWALLOWS, noembed: SWALLOWS, noframes: SWALLOWS,
};

/** Attributes whose value is fetched or navigated to as a URL. */
const URL_ATTRS: ReadonlySet<string> = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'background', 'poster', 'cite', 'longdesc',
  'lowsrc', 'dynsrc', 'data', 'codebase', 'classid', 'archive', 'ping', 'manifest', 'usemap',
  'profile', 'icon', 'xlink:href',
]);

/** The one data: URL allowed: an inline raster image in `src` (a logo). */
const INLINE_IMAGE_RE = /^data:image\/(?:png|gif|jpeg|webp)[;,]/;

/**
 * What a URL parser would see: every ASCII control and whitespace removed
 * (browsers strip tab/newline anywhere and C0/space at the ends — removing
 * all of them is stricter), lower-cased.
 */
function urlKey(rawValue: string): string {
  return decodeCharRefs(rawValue)
    .replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/g, '')
    .toLowerCase();
}

/** CSS as the CSS parser sees it: comments gone, escapes decoded, no spaces. */
function cssKey(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\f]?/g, (_m, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
    })
    .replace(/\\([^\n])/g, '$1')
    .replace(/[\u0000-\u0020\u007f]/g, '')
    .toLowerCase();
}

function cssProblem(css: string): string | null {
  const key = cssKey(css);
  if (key.includes('expression(')) return 'must not contain CSS expression()';
  if (key.includes('javascript:') || key.includes('vbscript:')) {
    return 'must not contain javascript: or vbscript: URLs inside CSS';
  }
  return null;
}

function attrProblem(attr: ScannedAttr): string | null {
  if (attr.name.length > 2 && attr.name.startsWith('on')) {
    return `must not contain event-handler attributes such as onclick= or onerror= (found ${attr.name}=)`;
  }
  if (attr.name === 'style') {
    const css = cssProblem(decodeCharRefs(attr.value));
    if (css) return `${css} (in style=)`;
  }
  const key = urlKey(attr.value);
  // Anywhere, in any attribute: srcset entries, refresh targets and the like
  // carry URLs outside href/src, and no legitimate value needs the scheme.
  if (key.includes('javascript:') || key.includes('vbscript:')) {
    return `must not contain javascript: or vbscript: URLs (in ${attr.name}=)`;
  }
  if (URL_ATTRS.has(attr.name) && key.includes('data:')
    && !(attr.name === 'src' && INLINE_IMAGE_RE.test(key))) {
    return `must not contain data: URLs other than an inline PNG/GIF/JPEG/WebP image in src= (in ${attr.name}=)`;
  }
  return null;
}

const ISSUE_PROBLEM: Readonly<Record<Exclude<ScanIssue['kind'], 'unclosed-raw-text'>, string>> = {
  'doctype': 'must not contain a <!DOCTYPE> (the header and footer are fragments inside the email body)',
  'unclosed-comment': 'must not leave an <!-- comment open (it would hide the rest of the email)',
  'unclosed-markup': `must not leave a <! or <? construct without its closing > (${SWALLOWS})`,
  'unterminated-tag': `must not end inside a tag or an attribute value (${SWALLOWS})`,
};

/**
 * Why `html` cannot be used as an email header/footer, or null when it can.
 * Phrased to follow "HTML …" in a validation message.
 */
export function emailChromeProblem(html: string): string | null {
  if (utf8ByteLength(html) > EMAIL_CHROME_MAX_BYTES) {
    return `must be at most ${EMAIL_CHROME_MAX_BYTES / 1024} KB`;
  }
  const scan = scanHtml(html);
  for (const tag of scan.tags) {
    const reason = FORBIDDEN_TAGS[tag.name];
    if (reason) return `must not contain <${tag.name}> tags (${reason})`;
  }
  for (const tag of scan.tags) {
    for (const attr of tag.attrs) {
      const problem = attrProblem(attr);
      if (problem) return problem;
    }
  }
  for (const block of scan.rawText) {
    const css = cssProblem(block.text);
    if (css) return `${css} (in a <${block.tag}> block)`;
  }
  if (scan.issue) {
    return scan.issue.kind === 'unclosed-raw-text'
      ? `must close every <${scan.issue.tag}> element (an open one swallows the email body as CSS)`
      : ISSUE_PROBLEM[scan.issue.kind];
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
