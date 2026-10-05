/**
 * A minimal HTML tokenizer for validating an email header/footer fragment.
 *
 * Regexes over raw HTML disagree with browsers in exactly the places an
 * attacker aims for: an abruptly closed comment (`<!-->`), a `/` between
 * attributes (`<img/onerror=…>`), a quote that hides a `>`, a `</style>`
 * inside a CSS string. This scanner follows the WHATWG tokenizer states for
 * the constructs that matter — tags and their attributes, comments, bogus
 * comments and raw-text elements — so the validator sees the same tags and
 * attributes a browser or mail client will.
 *
 * Deliberately NOT modelled, and therefore refused by the validator instead:
 * foreign content (`<svg>`, `<math>`), where `<style>` stops being raw text
 * and CDATA sections exist. Where it has to choose, the scanner errs towards
 * reporting more, never less.
 */

export interface ScannedAttr {
  /** Lower-cased, as the browser stores it. */
  readonly name: string;
  /** Raw value — character references NOT yet decoded. */
  readonly value: string;
}

export interface ScannedTag {
  readonly name: string;
  readonly isEnd: boolean;
  readonly attrs: readonly ScannedAttr[];
}

export type ScanIssue =
  | { readonly kind: 'doctype' }
  | { readonly kind: 'unclosed-comment' }
  | { readonly kind: 'unclosed-markup' }
  | { readonly kind: 'unterminated-tag' }
  | { readonly kind: 'unclosed-raw-text'; readonly tag: string };

export interface ScanResult {
  readonly tags: readonly ScannedTag[];
  /** Text content of raw-text elements (the CSS of `<style>` blocks). */
  readonly rawText: readonly { readonly tag: string; readonly text: string }[];
  /** Why scanning stopped early, or null when the whole fragment parsed. */
  readonly issue: ScanIssue | null;
}

/** Elements whose content is text up to the matching end tag, not markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title',
]);

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f';
}

function isAsciiAlpha(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z]$/.test(c);
}

/**
 * End of a comment whose `<!--` ends at `from`, per the tokenizer: `<!-->`
 * and `<!--->` close immediately; otherwise the first `-->` or `--!>`.
 */
function commentEnd(s: string, from: number): number {
  if (s[from] === '>') return from + 1;
  if (s.startsWith('->', from)) return from + 2;
  const a = s.indexOf('-->', from);
  const b = s.indexOf('--!>', from);
  if (a === -1 && b === -1) return -1;
  if (b === -1 || (a !== -1 && a < b)) return a + 3;
  return b + 4;
}

/** Start of the end tag that closes a raw-text element, or -1. */
function rawTextEnd(s: string, from: number, tag: string): number {
  const re = new RegExp(`</${tag}(?=[\\t\\n\\f />])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index : -1;
}

/**
 * Read a tag from just after `<` or `</`. Returns null when the input ends
 * inside it — in a composed email that would swallow what follows.
 */
function readTag(s: string, start: number, isEnd: boolean): { tag: ScannedTag; next: number } | null {
  let i = start;
  let name = '';
  while (i < s.length && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>') name += s[i++];
  const attrs: ScannedAttr[] = [];
  const done = (at: number) => ({ tag: { name: name.toLowerCase(), isEnd, attrs }, next: at });

  for (;;) {
    // Before attribute name. A `/` not followed by `>` is a separator.
    while (i < s.length && (isSpace(s[i]) || s[i] === '/')) i++;
    if (i >= s.length) return null;
    if (s[i] === '>') return done(i + 1);

    // Attribute name. A leading `=` is part of the name (parse error).
    let attrName = s[i++];
    while (i < s.length && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>' && s[i] !== '=') attrName += s[i++];
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) return null;
    if (s[i] !== '=') {
      attrs.push({ name: attrName.toLowerCase(), value: '' });
      continue;
    }
    i++;
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) return null;
    if (s[i] === '>') {
      attrs.push({ name: attrName.toLowerCase(), value: '' });
      return done(i + 1);
    }
    let value = '';
    if (s[i] === '"' || s[i] === "'") {
      const close = s.indexOf(s[i], i + 1);
      if (close === -1) return null;
      value = s.slice(i + 1, close);
      i = close + 1;
    } else {
      while (i < s.length && !isSpace(s[i]) && s[i] !== '>') value += s[i++];
    }
    attrs.push({ name: attrName.toLowerCase(), value });
  }
}

export function scanHtml(input: string): ScanResult {
  const s = input.replace(/\r\n?/g, '\n');
  const tags: ScannedTag[] = [];
  const rawText: { tag: string; text: string }[] = [];
  const stop = (issue: ScanIssue): ScanResult => ({ tags, rawText, issue });

  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1 || lt + 1 >= s.length) break;
    const c = s[lt + 1];

    if (c === '!') {
      if (s.startsWith('<!--', lt)) {
        const end = commentEnd(s, lt + 4);
        if (end === -1) return stop({ kind: 'unclosed-comment' });
        i = end;
        continue;
      }
      if (/^<!doctype/i.test(s.slice(lt, lt + 9))) return stop({ kind: 'doctype' });
    }
    if (c === '!' || c === '?' || (c === '/' && s[lt + 2] !== undefined && s[lt + 2] !== '>' && !isAsciiAlpha(s[lt + 2]))) {
      // Bogus comment: everything up to the next `>`.
      const gt = s.indexOf('>', lt + 2);
      if (gt === -1) return stop({ kind: 'unclosed-markup' });
      i = gt + 1;
      continue;
    }
    if (c === '/' && s[lt + 2] === '>') {
      i = lt + 3;
      continue;
    }

    const isEnd = c === '/';
    const nameStart = isEnd ? lt + 2 : lt + 1;
    if (!isAsciiAlpha(s[nameStart])) {
      i = lt + 1; // `<` followed by anything else is text
      continue;
    }
    const read = readTag(s, nameStart, isEnd);
    if (!read) return stop({ kind: 'unterminated-tag' });
    tags.push(read.tag);
    i = read.next;

    if (!isEnd && RAW_TEXT_ELEMENTS.has(read.tag.name)) {
      const close = rawTextEnd(s, i, read.tag.name);
      if (close === -1) return stop({ kind: 'unclosed-raw-text', tag: read.tag.name });
      rawText.push({ tag: read.tag.name, text: s.slice(i, close) });
      i = close;
    }
  }
  return { tags, rawText, issue: null };
}

/**
 * Character references the way an attribute value decodes them: numeric
 * (decimal/hex, `;` optional, leading zeros allowed) plus the named ones that
 * can spell a URL scheme or a CSS call. One pass, like the browser:
 * `&amp;#106;` stays the literal text `&#106;`.
 */
const NAMED_REFS: Readonly<Record<string, string>> = {
  colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\',
  semi: ';', comma: ',', period: '.', excl: '!', num: '#', quot: '"', apos: "'",
  amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', equals: '=', percnt: '%', lowbar: '_',
};

export function decodeCharRefs(value: string): string {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
    (whole, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) return NAMED_REFS[named.toLowerCase()] ?? whole;
      const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(cp);
    });
}
