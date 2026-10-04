/**
 * A notification's list of items, capped by COUNT — never by characters.
 *
 * Emitters used to join items into one string and `.slice(0, 2000)` it, which
 * both ran every item into one paragraph and could cut the last one in half.
 * A `string[]` is rendered as a real list on every channel
 * (templates/list-vars.ts); this keeps a long one readable.
 */
export const DEFAULT_LIST_MAX = 25;

export function cappedList(items: readonly string[], max = DEFAULT_LIST_MAX): string[] {
  if (items.length <= max) return [...items];
  return [...items.slice(0, max), `…and ${items.length - max} more.`];
}
