/**
 * Accessibility bookkeeping for the global tooltip layer.
 *
 * While a trigger is hovered the layer blanks its `title` (that is the only way
 * to stop the browser drawing its own tooltip on top of ours). A `title` is
 * part of the accessibility tree, though: it is the element's accessible NAME
 * when nothing else names it (an icon-only button) and its DESCRIPTION
 * otherwise. These helpers keep whichever role it played while it is blanked:
 *   - name        → mirror the text into `aria-label`
 *   - description → point `aria-describedby` at the tooltip bubble
 * and undo exactly what they added afterwards.
 *
 * NOTE: duplicated byte-for-byte in admin-panel and tenant-panel
 * (`src/lib/tooltip/`); `tooltip-parity.test.ts` fails if they drift.
 */

const BUTTON_LIKE_INPUTS = new Set(['button', 'submit', 'reset']);

/**
 * Whether the element has an accessible name from somewhere other than its
 * `title` — i.e. whether `title` is only its description. A deliberately small
 * subset of the accname algorithm: author labels, `<label>`s, button-like
 * input values, `alt`, and text content.
 *
 * `ignoreAriaLabel`: the current `aria-label` is the layer's own mirror of the
 * title, so it must not count as "another" name.
 */
export function hasNameBesidesTitle(el: HTMLElement, ignoreAriaLabel = false): boolean {
  if (!ignoreAriaLabel && el.getAttribute('aria-label')?.trim()) return true;
  if (el.getAttribute('aria-labelledby')?.trim()) return true;
  // `labels` exists on every labelable element (input, select, textarea, button, …).
  const labels = 'labels' in el ? (el as HTMLInputElement).labels : null;
  if (labels && labels.length > 0) return true;
  if (el instanceof HTMLInputElement) {
    if (BUTTON_LIKE_INPUTS.has(el.type)) return el.type !== 'button' || el.value.trim() !== '';
    if (el.type === 'image') return el.alt.trim() !== '';
    return false; // text-like inputs are named by labels, then title — never by content
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return false;
  if (el instanceof HTMLImageElement) return el.alt.trim() !== '';
  return (el.textContent ?? '').trim() !== '';
}

function idList(el: HTMLElement): string[] {
  return (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
}

export function addDescribedBy(el: HTMLElement, id: string): void {
  const ids = idList(el);
  if (!ids.includes(id)) el.setAttribute('aria-describedby', [...ids, id].join(' '));
}

export function removeDescribedBy(el: HTMLElement, id: string): void {
  const rest = idList(el).filter((x) => x !== id);
  if (rest.length > 0) el.setAttribute('aria-describedby', rest.join(' '));
  else el.removeAttribute('aria-describedby');
}
