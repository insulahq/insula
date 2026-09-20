import type { ReactNode } from 'react';

/**
 * Render our release notes as React ELEMENTS — never as HTML.
 *
 * The changelog modal used to print the notes through `whitespace-pre-wrap`,
 * and the comment there gave the reason: the body is remote content, and
 * rendering it as HTML would put a third party's markup inside an
 * authenticated admin page. That reason is still good, so this renderer never
 * produces an HTML string and there is no `dangerouslySetInnerHTML` anywhere
 * in the path. Every node below is a React element built from parsed text, so
 * markup in the source is text, not markup.
 *
 * It covers the subset our CHANGELOG.md actually uses, verified against a real
 * published release body rather than a specification:
 *
 *   ### Added                      headings, levels 1-4
 *   - **Lead sentence.** body…     bullets, with CONTINUATION LINES indented
 *                                  two spaces — the format wraps prose inside
 *                                  one bullet, and treating each wrapped line
 *                                  as its own item is the obvious way to get
 *                                  this wrong
 *   **bold** *italic* `code`       inline spans
 *   [text](https://…)              links, http(s) only
 *   ```                            fenced code
 *   ---                            horizontal rule
 *
 * Anything it does not recognise falls through as plain text, so an
 * unsupported construct degrades to exactly what the modal showed before
 * rather than disappearing.
 */

/** Links are the only place a URL from remote content reaches an attribute. */
function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  // Scheme allow-list, not a deny-list: `javascript:`, `data:` and friends
  // are excluded by not being on it, so a novel scheme cannot slip through.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;

/** Parse the inline spans of one already-joined line of prose. */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index;
    if (start > last) out.push(text.slice(last, start));
    const tok = m[0];
    const key = `${keyPrefix}-i${i}`;
    i += 1;
    if (tok.startsWith('**')) {
      out.push(<strong key={key} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('[')) {
      const split = tok.indexOf('](');
      const label = tok.slice(1, split);
      const href = safeHref(tok.slice(split + 2, -1));
      // A link we will not follow still has to show its text — dropping it
      // would silently delete a sentence's subject.
      out.push(href
        ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-blue-600 hover:underline dark:text-blue-400">
            {label}
          </a>
        )
        : <span key={key}>{label}</span>);
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

/**
 * Group lines into blocks. Exported so the wrapping rules can be tested
 * against real release bodies without rendering React.
 */
export function parseChangelogBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length > 0) { blocks.push({ kind: 'para', text: para.join(' ').trim() }); para = []; }
  };
  const flushList = () => {
    if (list && list.length > 0) { blocks.push({ kind: 'list', items: list }); }
    list = null;
  };

  for (const line of lines) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) { blocks.push({ kind: 'code', text: fence.join('\n') }); fence = null; }
      else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); flushList(); fence = []; continue; }

    if (line.trim() === '') { flushPara(); flushList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ kind: 'rule' }); continue; }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list) list = [];
      list.push(bullet[2]!.trim());
      continue;
    }

    // An indented line directly under a bullet CONTINUES that bullet — this
    // is how the changelog wraps prose. Without this every wrapped line
    // became its own paragraph and the list fell apart mid-sentence.
    if (list && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  if (fence !== null) blocks.push({ kind: 'code', text: fence.join('\n') });
  flushPara();
  flushList();
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-4 text-base font-semibold text-gray-900 dark:text-gray-100',
  2: 'mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100',
  3: 'mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100',
  4: 'mt-3 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400',
};

export function renderChangelog(src: string): ReactNode {
  const blocks = parseChangelogBlocks(src);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-gray-800 dark:text-gray-200">
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        if (b.kind === 'heading') {
          const cls = HEADING_CLASS[b.level] ?? HEADING_CLASS[3]!;
          return <p key={key} className={`${cls} first:mt-0`}>{renderInline(b.text, key)}</p>;
        }
        if (b.kind === 'rule') return <hr key={key} className="my-3 border-gray-200 dark:border-gray-700" />;
        if (b.kind === 'code') {
          return (
            <pre key={key} className="overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
              {b.text}
            </pre>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={key} className="list-disc space-y-1.5 pl-5">
              {b.items.map((it, ii) => <li key={`${key}-${ii}`}>{renderInline(it, `${key}-${ii}`)}</li>)}
            </ul>
          );
        }
        return <p key={key}>{renderInline(b.text, key)}</p>;
      })}
    </div>
  );
}
