/**
 * Global tooltip layer: every `title="…"` in the panel renders as a styled,
 * never-clipped bubble instead of the browser's native tooltip.
 *
 * One delegated listener set on the document, no per-element state and no
 * React re-renders: the closest element with a non-empty `title` under the
 * pointer (or under keyboard focus) is the trigger.
 *
 * Suppressing the native tooltip. While the POINTER is on a trigger its
 * `title` is blanked to "" — the text moves to `data-tooltip-title` — and put
 * back when the pointer leaves, the trigger is removed, or the layer is torn
 * down; the attribute is always there again afterwards, so `getByTitle`, tests
 * and assistive tech keep working. Blanking (not removing) matters: React
 * removing the prop mid-hover is then a real, observable attribute removal, so
 * a stale title is never restored over the app's intent. The accessible
 * name/description `title` provided is kept meanwhile (`tooltip-a11y.ts`) and
 * re-classified whenever the app changes the trigger's `aria-label`,
 * `aria-describedby` or text mid-hover; a value the APP wrote is never
 * removed or overwritten.
 * Keyboard focus never blanks anything — browsers draw no native tooltip for
 * focus.
 *
 * Opt out a subtree with `data-native-title`. SVG `<title>` children are left
 * to the browser.
 *
 * NOTE: duplicated byte-for-byte in admin-panel and tenant-panel
 * (`src/lib/tooltip/`); `tooltip-parity.test.ts` fails if they drift.
 */
import { addDescribedBy, hasNameBesidesTitle, removeDescribedBy } from './tooltip-a11y';
import { TOOLTIP_ID, createTooltipBubble, type TooltipBubble } from './tooltip-bubble';
import { computeTooltipLayout } from './tooltip-position';

export { TOOLTIP_ID };
/** Holds a hovered trigger's title while its `title` is blanked. */
export const STASH_ATTR = 'data-tooltip-title';
/** Elements inside a subtree carrying this attribute keep the native tooltip. */
export const OPT_OUT_ATTR = 'data-native-title';
export const SHOW_DELAY_MS = 200;
/** A trigger reached within this long of the last bubble closing shows at once. */
export const WARM_MS = 300;
/** Triggers wider than this anchor at the pointer, not at their centre. */
const WIDE_TRIGGER_PX = 240;

/**
 * Watched only while a trigger is armed. childList/characterData: the trigger
 * leaving the DOM or its text (= its accessible name) changing; attributes:
 * the app rewriting what the layer mirrors or blanks.
 */
const OBSERVE: MutationObserverInit = {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['title', 'aria-label', 'aria-describedby'],
};

type Source = 'pointer' | 'focus';

interface Armed {
  readonly el: HTMLElement;
  readonly source: Source;
  /** The trigger's title, verbatim — what gets restored. */
  readonly title: string;
  /** `title` is blanked by us (pointer only). */
  readonly stashed: boolean;
  /** The current `aria-label` is our mirror of the title (the app wrote none since). */
  readonly addedLabel: boolean;
  /** Our id is (meant to be) in `aria-describedby`. */
  readonly addedDescription: boolean;
  /** Hidden by Escape/click/scroll/resize; stays quiet until the trigger changes. */
  readonly dismissed: boolean;
}

function hasSvgTitleChild(node: SVGElement): boolean {
  return Array.from(node.children).some((c) => c.localName === 'title');
}

function viewportSize(): { width: number; height: number } {
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
}

let uninstallActive: (() => void) | null = null;

/**
 * Install the layer on `document`. Returns the uninstaller. A second install
 * while one is active is a no-op (one listener set per document).
 */
export function installGlobalTooltips(): () => void {
  if (uninstallActive || typeof document === 'undefined' || !document.body) return () => {};
  const dispose = createLayer();
  let done = false;
  const uninstall = (): void => {
    if (done) return;
    done = true;
    dispose();
    uninstallActive = null;
  };
  uninstallActive = uninstall;
  return uninstall;
}

function createLayer(): () => void {
  const bubble: TooltipBubble = createTooltipBubble();
  let armed: Armed | null = null;
  let visible = false;
  let showTimer: number | undefined;
  let frame: number | undefined;
  let lastHiddenAt = Number.NEGATIVE_INFINITY;
  let keyboardModality = false;
  let pointerX: number | undefined;
  const observer = new MutationObserver(onMutations);

  /** The trigger for an event target: nearest ancestor-or-self with a usable title. */
  function findTrigger(start: EventTarget | null): HTMLElement | null {
    let node: Element | null = start instanceof Element ? start : null;
    if (node?.localName === 'iframe') return null;
    while (node) {
      if (armed && node === armed.el) return armed.el;
      if (node instanceof SVGElement && hasSvgTitleChild(node)) return null;
      const html: HTMLElement | null = node instanceof HTMLElement ? node : null;
      if (html?.hasAttribute('title')) {
        // An empty title means "no advisory information" and hides ancestors' too.
        if ((html.getAttribute('title') ?? '').trim() === '') return null;
        return html.closest(`[${OPT_OUT_ATTR}]`) ? null : html;
      }
      node = node.parentElement;
    }
    return null;
  }

  /** Deliver mutations the app made that the observer has not reported yet. */
  function flushPending(): void {
    const pending = observer.takeRecords();
    if (pending.length > 0) onMutations(pending);
  }

  /**
   * Make our own attribute writes and drop the records they produce, so the
   * observer only ever reports the APP's changes. Only valid while no foreign
   * record is queued: inside the observer callback, or right after
   * flushPending(). Never nests.
   */
  function writeQuietly(write: () => void): void {
    write();
    observer.takeRecords();
  }

  function stash(a: Armed): Armed {
    a.el.setAttribute(STASH_ATTR, a.title);
    a.el.setAttribute('title', '');
    return applyA11y({ ...a, stashed: true });
  }

  /**
   * Make the blanked title keep the role it had: the trigger's NAME when
   * nothing else names it (mirror into aria-label), its DESCRIPTION otherwise
   * (our id in aria-describedby). Run at arm time and again whenever the app
   * changes what names the trigger. Never touches an aria-label the app owns.
   */
  function applyA11y(a: Armed): Armed {
    const { el } = a;
    if (hasNameBesidesTitle(el, a.addedLabel)) {
      if (a.addedLabel) el.removeAttribute('aria-label');
      addDescribedBy(el, TOOLTIP_ID);
      return { ...a, addedLabel: false, addedDescription: true };
    }
    if (a.addedDescription) removeDescribedBy(el, TOOLTIP_ID);
    // An aria-label="" the app set is its (odd) intent — leave it.
    const label = a.addedLabel || !el.hasAttribute('aria-label');
    if (label) el.setAttribute('aria-label', a.title.trim());
    return { ...a, addedLabel: label, addedDescription: false };
  }

  function restore(a: Armed, putTitleBack: boolean): void {
    const { el } = a;
    el.removeAttribute(STASH_ATTR);
    if (a.stashed && putTitleBack && el.getAttribute('title') === '') el.setAttribute('title', a.title);
    if (a.addedLabel && el.getAttribute('aria-label') === a.title.trim()) el.removeAttribute('aria-label');
    if (a.addedDescription) removeDescribedBy(el, TOOLTIP_ID);
  }

  function arm(el: HTMLElement, source: Source): void {
    const base: Armed = {
      el, source, title: el.getAttribute('title') ?? '',
      stashed: false, addedLabel: false, addedDescription: false, dismissed: false,
    };
    armed = source === 'pointer' ? stash(base) : base;
    bubble.setText(base.title);
    observer.observe(document.body, OBSERVE);
    scheduleShow();
  }

  function disarm(putTitleBack = true): void {
    if (!armed) return;
    // disconnect() drops queued records: apply the app's last changes first, so
    // restore() never writes stale state over them (and may find it disarmed).
    flushPending();
    const a = armed;
    if (!a) return;
    armed = null;
    observer.disconnect();
    hide();
    restore(a, putTitleBack);
  }

  function clearTimers(): void {
    if (showTimer !== undefined) window.clearTimeout(showTimer);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    showTimer = undefined;
    frame = undefined;
  }

  function scheduleShow(): void {
    clearTimers();
    if (Date.now() - lastHiddenAt < WARM_MS) show();
    else showTimer = window.setTimeout(show, SHOW_DELAY_MS);
  }

  function show(): void {
    showTimer = undefined;
    const a = armed;
    if (!a || a.dismissed) return;
    if (!a.el.isConnected) {
      disarm();
      return;
    }
    bubble.open();
    const placement = position();
    visible = true;
    bubble.fadeIn(placement);
  }

  function hide(): void {
    clearTimers();
    if (!visible) return;
    visible = false;
    lastHiddenAt = Date.now();
    bubble.close();
  }

  function dismiss(): void {
    if (!armed) return;
    hide();
    armed = { ...armed, dismissed: true };
  }

  function position(): 'top' | 'bottom' {
    const a = armed;
    if (!a) return 'top';
    const trigger = a.el.getBoundingClientRect();
    const anchorX = a.source === 'pointer' && trigger.width > WIDE_TRIGGER_PX ? pointerX : undefined;
    const layout = computeTooltipLayout({ trigger, bubble: bubble.measure(), viewport: viewportSize(), anchorX });
    bubble.place(layout);
    return layout.placement;
  }

  function scheduleReposition(): void {
    if (!visible || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (visible) position();
    });
  }

  /** The app's mutations (ours are dropped by writeQuietly) while a trigger is armed. */
  function onMutations(records: MutationRecord[]): void {
    const first = armed;
    if (!first) return;
    if (!first.el.isConnected) {
      disarm();
      return;
    }
    const { el } = first;
    const changed = new Set(
      records.filter((r) => r.type === 'attributes' && r.target === el).map((r) => r.attributeName),
    );
    // Any app write to aria-label makes it the app's, even with our very value.
    if (changed.has('aria-label') && first.addedLabel) armed = { ...first, addedLabel: false };
    if (changed.has('title')) onTitleChanged();
    const contentChanged = records.some((r) => r.type !== 'attributes' && el.contains(r.target));
    const a = armed;
    if (a?.stashed && (changed.has('aria-label') || changed.has('aria-describedby') || contentChanged)) {
      writeQuietly(() => {
        armed = applyA11y(a);
      });
    }
    if (records.some((r) => r.type !== 'attributes')) scheduleReposition();
  }

  /** The app changed the trigger's title (our own writes never reach here). */
  function onTitleChanged(): void {
    const a = armed;
    if (!a) return;
    const next = a.el.getAttribute('title');
    if (next === null || next.trim() === '') {
      disarm(false);
      return;
    }
    writeQuietly(() => {
      if (a.stashed) {
        a.el.setAttribute(STASH_ATTR, next);
        a.el.setAttribute('title', '');
      }
      if (a.addedLabel) a.el.setAttribute('aria-label', next.trim());
    });
    armed = { ...a, title: next };
    bubble.setText(next);
    scheduleReposition();
  }

  /* ── event handlers ─────────────────────────────────────────── */

  function onPointerOver(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    pointerX = e.clientX;
    const trigger = findTrigger(e.target);
    const a = armed;
    if (a && trigger === a.el) {
      if (!a.stashed) hoverFocusedTrigger();
      return;
    }
    if (!trigger) {
      if (a?.source === 'pointer') disarm();
      return;
    }
    disarm();
    arm(trigger, 'pointer');
  }

  /**
   * The pointer reached the trigger keyboard focus armed: blank its title now
   * (the native tooltip would draw otherwise) and treat it as a fresh hover —
   * an Escape that dismissed the focus bubble does not silence the hover.
   */
  function hoverFocusedTrigger(): void {
    flushPending(); // an app change queued in this same tick may retitle or disarm it
    const a = armed;
    if (!a || a.stashed) return;
    writeQuietly(() => {
      armed = { ...stash(a), source: 'pointer', dismissed: false };
    });
    if (!visible) scheduleShow();
  }

  function onPointerOut(e: PointerEvent): void {
    // relatedTarget null = the pointer left the window.
    if (e.relatedTarget === null && e.pointerType !== 'touch' && armed?.source === 'pointer') disarm();
  }

  function onPointerMove(e: PointerEvent): void {
    if (armed && !visible && e.pointerType !== 'touch') pointerX = e.clientX;
  }

  function onPointerDown(): void {
    keyboardModality = false;
    dismiss();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (visible || showTimer !== undefined) dismiss();
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardModality = true;
  }

  function onFocusIn(e: FocusEvent): void {
    if (!keyboardModality) return;
    const trigger = findTrigger(e.target);
    if (!trigger) return;
    const a = armed;
    if (a && trigger === a.el) {
      if (a.dismissed) {
        armed = { ...a, dismissed: false };
        scheduleShow();
      }
      return;
    }
    disarm();
    arm(trigger, 'focus');
  }

  function onFocusOut(e: FocusEvent): void {
    const a = armed;
    if (!a || a.source !== 'focus') return;
    if (e.relatedTarget instanceof Node && a.el.contains(e.relatedTarget)) return;
    disarm();
  }

  function onScroll(e: Event): void {
    const a = armed;
    if (!a || !visible) return;
    const t = e.target;
    if (t === document || (t instanceof Node && t.contains(a.el))) dismiss();
  }

  // Dismiss, not disarm: the pointer may still rest on the trigger when the
  // window comes back, and a restored title would draw the native tooltip on
  // the next mouse move. Leaving the trigger restores it as usual.
  function onWindowBlur(e: Event): void {
    if (!(e.target instanceof Node)) dismiss(); // the window itself, not an element
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') dismiss();
  }

  const listeners: ReadonlyArray<readonly [EventTarget, string, (e: never) => void, AddEventListenerOptions]> = [
    [document, 'pointerover', onPointerOver, { capture: true, passive: true }],
    [document, 'pointerout', onPointerOut, { capture: true, passive: true }],
    [document, 'pointermove', onPointerMove, { capture: true, passive: true }],
    [document, 'pointerdown', onPointerDown, { capture: true, passive: true }],
    [document, 'keydown', onKeyDown, { capture: true }],
    [document, 'focusin', onFocusIn, { capture: true }],
    [document, 'focusout', onFocusOut, { capture: true }],
    [document, 'scroll', onScroll, { capture: true, passive: true }],
    [document, 'visibilitychange', onVisibilityChange, {}],
    [window, 'resize', dismiss, { passive: true }],
    [window, 'blur', onWindowBlur, {}],
  ];
  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn as EventListener, opts);

  return () => {
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn as EventListener, opts);
    disarm();
    observer.disconnect();
    bubble.remove();
  };
}
