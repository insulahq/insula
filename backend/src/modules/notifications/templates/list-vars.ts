/**
 * List variables — several items in one notification, rendered as a list on
 * every channel.
 *
 * Operator requirement: a notification about several things (tenants,
 * mailboxes, failed checks, …) shows each one as its own list item — in the
 * email, in the in-app feed and on the phone. Emitters used to join them into
 * one string, so "Acme: primary node sv1, but data on sv2. Beta: primary
 * node sv1, but data on sv2. SYSTEM: …" arrived as a single paragraph.
 *
 * An emitter passes a `string[]` (declared `type: 'list'` in the template's
 * variables) and the renderer formats it for where it lands:
 *   - an HTML email body: an escaped `<ul>` (inline styles — it is an email),
 *     handed to Handlebars as a SafeString so a plain `{{details}}` renders
 *     it — operator-edited templates keep working unchanged;
 *   - a plaintext body (in-app, ntfy): one `• item` per line;
 *   - a subject: comma-joined, because a subject is one line.
 */
import Handlebars from 'handlebars';

export type ListTarget = 'subject' | 'html' | 'text';

/**
 * Every array is a list. Not just a `string[]`: an array that slipped through
 * with a null or a number must still be escaped item by item — handed to
 * Handlebars raw, a triple-stache would print it unescaped.
 */
export function isList(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

/** One list, formatted for `target`. Blank and null items are dropped. Pure. */
export function formatList(items: readonly unknown[], target: ListTarget): string | Handlebars.SafeString {
  const kept = items
    .filter((i) => i !== null && i !== undefined)
    .map((i) => String(i).trim())
    .filter((i) => i.length > 0);
  if (kept.length === 0) return '';
  if (target === 'subject') return kept.join(', ');
  if (target === 'text') return `\n${kept.map((i) => `• ${i}`).join('\n')}\n`;
  const lis = kept.map((i) => `<li style="margin:0 0 4px 0">${Handlebars.escapeExpression(i)}</li>`).join('');
  return new Handlebars.SafeString(`<ul style="margin:8px 0;padding-left:20px">${lis}</ul>`);
}

/** Every list variable formatted for `target`; other values untouched. Pure. */
export function prepareListVariables(vars: Record<string, unknown>, target: ListTarget): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (isList(v)) { out[k] = formatList(v, target); changed = true; } else out[k] = v;
  }
  return changed ? out : vars;
}

/** True when any variable is a list. Pure. */
export function hasListVariable(vars: Record<string, unknown>): boolean {
  return Object.values(vars).some(isList);
}
