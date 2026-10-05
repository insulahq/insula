/**
 * The provider "Send test" message, and the plain-text rendering of an email
 * header/footer.
 *
 * The test email is how an operator sees the real result of a header/footer
 * before a notification goes out, so it carries them: with any set, it gains
 * an HTML part composed by the same `applyEmailChrome` the queue worker uses.
 * With none set it stays exactly the historical text-only message.
 *
 * Text part: notification emails are sent HTML-only today, so the worker has
 * no text part to extend and none is invented for them. The test email has
 * always been text, so its text part keeps working for text-only clients and
 * gets a tag-stripped rendering of the header and footer around the sentence.
 */
import { applyEmailChrome, hasEmailChrome, type EmailChrome } from '@insula/api-contracts';

export interface ProviderTestMessage {
  readonly text: string;
  /** Present only when the provider has a header or footer. */
  readonly html?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildProviderTestMessage(providerName: string, chrome: EmailChrome): ProviderTestMessage {
  const sentence = `This is an automated test from the notification provider "${providerName}". If you received this, the provider's SMTP credentials are working.`;
  if (!hasEmailChrome(chrome)) return { text: `${sentence}\n` };

  const body = `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:22px;color:#333;">${escapeHtml(sentence)}</p>`;
  const text = [htmlToText(chrome.headerHtml), sentence, htmlToText(chrome.footerHtml)]
    .filter((part) => part.length > 0)
    .join('\n\n');
  return { text: `${text}\n`, html: applyEmailChrome(body, chrome) };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
};

/** One pass, so `&amp;lt;` becomes `&lt;` and not `<`. Unknown names stay. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Output stays entity-encoded (the caller decodes once); compare decoded. */
function linkToText(href: string, inner: string): string {
  const label = inner.replace(/<[^>]+>/g, '').trim();
  const target = href.trim();
  const plainLabel = decodeEntities(label);
  const plainTarget = decodeEntities(target);
  if (!plainLabel) return target;
  if (plainLabel === plainTarget || `mailto:${plainLabel}` === plainTarget) return label;
  return `${label} (${target})`;
}

/**
 * A readable plain-text rendering of an HTML fragment: block ends and `<br>`
 * become line breaks, list items bullets, links keep their target, entities
 * are decoded, and spacing is collapsed. Not a general converter — it only
 * has to render a header/footer an operator wrote.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q: string, href: string, inner: string) => linkToText(href, inner))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote|section|header|footer|center)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
