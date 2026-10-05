/**
 * The one tooltip bubble the global layer draws into.
 *
 * Never clipped: it is appended to <body> and, where the browser supports the
 * Popover API, opened as a `popover="manual"` so it renders in the TOP LAYER —
 * above every z-index, `overflow: hidden` ancestor, transformed container and
 * future modal <dialog>. Elsewhere it falls back to `position: fixed` with a
 * z-index above every overlay in the panels.
 *
 * Look (DaisyUI-style): a compact neutral bubble with a small arrow — dark on
 * the light theme, a lighter grey on the dark theme so it still stands off the
 * gray-800/900 surfaces. `whitespace-pre-line` keeps a title's `\n` breaks.
 *
 * NOTE: duplicated byte-for-byte in admin-panel and tenant-panel
 * (`src/lib/tooltip/`); `tooltip-parity.test.ts` fails if they drift.
 */
import {
  ARROW_HALF,
  ARROW_HEIGHT,
  type Size,
  type TooltipLayout,
  type TooltipPlacement,
} from './tooltip-position';

export const TOOLTIP_ID = 'insula-tooltip';

/* The popover UA sheet sets inset/margin/border/padding/overflow/colours —
   every one of them is overridden here. */
const BUBBLE_CLASSES = [
  'pointer-events-none fixed inset-auto left-0 top-0 z-[10000] m-0 w-max',
  'max-w-[min(20rem,calc(100vw-1rem))] overflow-visible rounded-md border-0 px-2 py-1',
  'bg-gray-900 text-left text-xs font-normal leading-snug text-white shadow-md',
  'dark:bg-gray-600 dark:text-white dark:shadow-black/40',
].join(' ');
const TEXT_CLASSES = 'block max-h-[calc(100vh-2rem)] overflow-hidden whitespace-pre-line wrap-anywhere';
/* bg-inherit: the arrow is always the bubble's colour, light or dark. */
const ARROW_CLASSES = 'pointer-events-none absolute bg-inherit';

const ARROW_DOWN = 'polygon(0 0, 100% 0, 50% 100%)';
const ARROW_UP = 'polygon(50% 0, 100% 100%, 0 100%)';
const FADE_MS = 120;

export interface TooltipBubble {
  readonly el: HTMLElement;
  setText(text: string): void;
  open(): void;
  close(): void;
  measure(): Size;
  place(layout: TooltipLayout): void;
  fadeIn(placement: TooltipPlacement): void;
  remove(): void;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createTooltipBubble(): TooltipBubble {
  const el = document.createElement('div');
  el.id = TOOLTIP_ID;
  el.setAttribute('role', 'tooltip');
  el.className = BUBBLE_CLASSES;

  const text = document.createElement('span');
  text.className = TEXT_CLASSES;
  const arrow = document.createElement('span');
  arrow.className = ARROW_CLASSES;
  arrow.setAttribute('aria-hidden', 'true');
  arrow.style.width = `${ARROW_HALF * 2}px`;
  arrow.style.height = `${ARROW_HEIGHT}px`;
  el.append(text, arrow);

  const usePopover = typeof el.showPopover === 'function';
  if (usePopover) el.setAttribute('popover', 'manual');
  else el.hidden = true;
  document.body.appendChild(el);

  const isOpen = (): boolean => (usePopover ? el.matches(':popover-open') : !el.hidden);

  return {
    el,
    setText(value) {
      text.textContent = value.trim();
    },
    open() {
      if (isOpen()) return;
      if (!usePopover) {
        el.hidden = false;
        return;
      }
      try {
        el.showPopover();
      } catch (err) {
        // InvalidStateError: detached or already shown — nothing to recover.
        if (!(err instanceof DOMException)) throw err;
      }
    },
    close() {
      if (!isOpen()) return;
      if (!usePopover) {
        el.hidden = true;
        return;
      }
      try {
        el.hidePopover();
      } catch (err) {
        // InvalidStateError: already hidden.
        if (!(err instanceof DOMException)) throw err;
      }
    },
    measure() {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    },
    place(layout) {
      el.style.left = `${layout.left}px`;
      el.style.top = `${layout.top}px`;
      el.dataset.placement = layout.placement;
      arrow.style.left = `${layout.arrowLeft - ARROW_HALF}px`;
      const above = layout.placement === 'top';
      arrow.style.top = above ? '100%' : '';
      arrow.style.bottom = above ? '' : '100%';
      arrow.style.clipPath = above ? ARROW_DOWN : ARROW_UP;
    },
    fadeIn(placement) {
      if (typeof el.animate !== 'function' || prefersReducedMotion()) return;
      const from = placement === 'top' ? 'translateY(3px)' : 'translateY(-3px)';
      el.animate(
        [{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }],
        { duration: FADE_MS, easing: 'ease-out' },
      );
    },
    remove() {
      el.remove();
    },
  };
}
