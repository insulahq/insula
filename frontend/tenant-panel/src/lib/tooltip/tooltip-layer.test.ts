import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  SHOW_DELAY_MS,
  STASH_ATTR,
  TOOLTIP_ID,
  WARM_MS,
  installGlobalTooltips,
} from './tooltip-layer';

/*
 * Behaviour of the global tooltip layer against plain DOM. jsdom has no
 * layout, no Popover API and no Web Animations, so this exercises the
 * `position: fixed` fallback path; the top-layer path is proven in a real
 * browser.
 */

let uninstall: () => void = () => {};

function mount(html: string): void {
  document.body.innerHTML = html;
  uninstall = installGlobalTooltips();
}

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

function hover(target: Element, init: PointerEventInit = {}): void {
  fireEvent.pointerOver(target, { pointerType: 'mouse', clientX: 10, clientY: 10, ...init });
}

function tooltip(): HTMLElement | null {
  return screen.queryByRole('tooltip');
}

async function flushMutations(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('global tooltip layer — hover', () => {
  it('shows the styled bubble after a short delay', () => {
    mount('<button id="b" title="Delete tenant">x</button><div id="away">away</div>');
    hover(el('#b'));
    expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    const bubble = tooltip();
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveTextContent('Delete tenant');
    expect(bubble!.id).toBe(TOOLTIP_ID);
    expect(bubble!.className).toContain('bg-gray-900');
    expect(bubble!.className).toContain('dark:bg-gray-600');
    expect(bubble!.className).toContain('fixed');
    expect(bubble!.parentElement).toBe(document.body);
  });

  it('suppresses the native title while hovered and restores it after leaving', () => {
    mount('<button id="b" title="Delete tenant">x</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    expect(b.getAttribute('title')).toBe('');
    expect(b.getAttribute(STASH_ATTR)).toBe('Delete tenant');
    vi.advanceTimersByTime(SHOW_DELAY_MS);

    hover(el('#away'));
    expect(tooltip()).toBeNull();
    expect(b.getAttribute('title')).toBe('Delete tenant');
    expect(b.hasAttribute(STASH_ATTR)).toBe(false);
  });

  it('restores the title when the pointer leaves the window', () => {
    mount('<button id="b" title="Delete tenant">x</button>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.pointerOut(b, { pointerType: 'mouse', relatedTarget: null });
    expect(tooltip()).toBeNull();
    expect(b.getAttribute('title')).toBe('Delete tenant');
  });

  it('keeps the accessible name of an icon-only button while its title is blanked', () => {
    mount('<button id="b" title="Delete"><svg aria-hidden="true"></svg></button><div id="away">away</div>');
    hover(el('#b'));
    expect(screen.getByRole('button', { name: 'Delete' })).toBe(el('#b'));
    hover(el('#away'));
    expect(el('#b').hasAttribute('aria-label')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete' })).toBe(el('#b'));
  });

  it('keeps a text button\'s title as its description and restores an existing aria-describedby', () => {
    mount('<span id="hint">Hint</span><button id="b" aria-describedby="hint" title="Removes it for good">Delete</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(b.getAttribute('aria-describedby')).toBe(`hint ${TOOLTIP_ID}`);
    expect(b).toHaveAccessibleName('Delete');
    expect(b.hasAttribute('aria-label')).toBe(false);
    hover(el('#away'));
    expect(b.getAttribute('aria-describedby')).toBe('hint');
  });

  it('preserves line breaks of a multi-line title', () => {
    mount('<span id="s" title="line one\nline two">x</span>');
    el('#s').setAttribute('title', 'line one\nline two');
    hover(el('#s'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    const text = tooltip()!.firstElementChild as HTMLElement;
    expect(text.textContent).toBe('line one\nline two');
    expect(text.className).toContain('whitespace-pre-line');
  });

  it('uses the innermost title and switches as the pointer moves between nested triggers', () => {
    mount('<div id="row" title="Row help"><button id="b" title="Button help">x</button></div>');
    const row = el('#row');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toHaveTextContent('Button help');
    expect(row.getAttribute('title')).toBe('Row help');

    hover(row);
    expect(tooltip()).toHaveTextContent('Row help'); // warm: no second delay
    expect(b.getAttribute('title')).toBe('Button help');
    expect(row.getAttribute('title')).toBe('');
  });

  it('shows the next trigger instantly while warm, and waits again once cold', () => {
    mount('<button id="a" title="A">a</button><button id="b" title="B">b</button><div id="away">away</div>');
    hover(el('#a'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    hover(el('#b'));
    expect(tooltip()).toHaveTextContent('B');

    hover(el('#away'));
    vi.advanceTimersByTime(WARM_MS + 1);
    hover(el('#a'));
    expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toHaveTextContent('A');
  });

  it('does nothing for an empty title, which also blocks an ancestor title (native semantics)', () => {
    mount('<div id="outer" title="Outer"><span id="s" title="  ">x</span></div>');
    hover(el('#s'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
    expect(el('#outer').getAttribute('title')).toBe('Outer');
  });

  it('leaves elements inside a data-native-title opt-out alone', () => {
    mount('<div data-native-title><button id="b" title="Native">x</button></div>');
    hover(el('#b'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
    expect(el('#b').getAttribute('title')).toBe('Native');
  });

  it('leaves SVG <title> tooltips to the browser', () => {
    mount('<div id="wrap" title="Chart"><svg><circle id="dot"><title>42 req/s</title></circle></svg></div>');
    hover(el('#dot'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
    expect(el('#wrap').getAttribute('title')).toBe('Chart');
  });

  it('ignores touch so taps are untouched', () => {
    mount('<button id="b" title="Delete">x</button>');
    hover(el('#b'), { pointerType: 'touch' });
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
    expect(el('#b').getAttribute('title')).toBe('Delete');
  });
});

describe('global tooltip layer — dismissal', () => {
  it('Escape hides the bubble; the title comes back once the pointer leaves', () => {
    mount('<button id="b" title="Delete">x</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(SHOW_DELAY_MS * 5);
    expect(tooltip()).toBeNull();
    // still blanked: the native tooltip must not pop up under the pointer
    expect(b.getAttribute('title')).toBe('');
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('Delete');
  });

  it('a click hides the bubble and it does not come back while the pointer stays', () => {
    mount('<button id="b" title="Delete">x</button>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.pointerDown(b, { pointerType: 'mouse' });
    expect(tooltip()).toBeNull();
    hover(b); // the pointer wanders inside the same trigger
    vi.advanceTimersByTime(SHOW_DELAY_MS * 5);
    expect(tooltip()).toBeNull();
  });

  it('a click during the show delay cancels the pending bubble', () => {
    mount('<button id="b" title="Delete">x</button>');
    hover(el('#b'));
    fireEvent.pointerDown(el('#b'), { pointerType: 'mouse' });
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(tooltip()).toBeNull();
  });

  it('hides when a scroll container holding the trigger scrolls, not when an unrelated one does', () => {
    mount('<div id="pane"><button id="b" title="Delete">x</button></div><div id="other"></div>');
    hover(el('#b'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.scroll(el('#other'));
    expect(tooltip()).not.toBeNull();
    fireEvent.scroll(el('#pane'));
    expect(tooltip()).toBeNull();
  });

  it('hides on window blur but keeps the title blanked while the pointer stays', () => {
    mount('<button id="b" title="Delete">x</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.blur(window);
    expect(tooltip()).toBeNull();
    expect(b.getAttribute('title')).toBe('');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(tooltip()).toBeNull();
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('Delete');
  });

  it('hides on window resize', () => {
    mount('<button id="b" title="Delete">x</button>');
    hover(el('#b'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent(window, new Event('resize'));
    expect(tooltip()).toBeNull();
  });

  it('hides when the trigger is removed from the DOM and restores its title', async () => {
    mount('<div id="host"><button id="b" title="Delete">x</button></div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).not.toBeNull();
    b.remove();
    await flushMutations();
    expect(tooltip()).toBeNull();
    expect(b.getAttribute('title')).toBe('Delete');
  });

  it('never shows for a trigger removed during the delay', () => {
    mount('<button id="b" title="Delete">x</button>');
    const b = el('#b');
    hover(b);
    b.remove();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
  });
});

describe('global tooltip layer — title changes while shown', () => {
  it('follows a new title and keeps the native one suppressed', async () => {
    mount('<button id="b" title="Old">x</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    b.setAttribute('title', 'New');
    await flushMutations();
    expect(tooltip()).toHaveTextContent('New');
    expect(b.getAttribute('title')).toBe('');
    expect(b.getAttribute(STASH_ATTR)).toBe('New');
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('New');
  });

  it('hides when the app removes the title, and does not put the old one back', async () => {
    mount('<button id="b" title="Old">x</button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    b.removeAttribute('title');
    await flushMutations();
    expect(tooltip()).toBeNull();
    hover(el('#away'));
    expect(b.hasAttribute('title')).toBe(false);
    expect(b.hasAttribute(STASH_ATTR)).toBe(false);
    expect(b.hasAttribute('aria-label')).toBe(false);
  });

  it('hides when the app blanks the title, and keeps it blank', async () => {
    mount('<button id="b" title="Old"><svg aria-hidden="true"></svg></button><div id="away">away</div>');
    const b = el('#b');
    hover(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    b.setAttribute('title', '');
    await flushMutations();
    expect(tooltip()).toBeNull();
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('');
    expect(b.hasAttribute('aria-label')).toBe(false);
  });
});

describe('global tooltip layer — keyboard focus', () => {
  it('shows on keyboard focus without touching the title, hides on blur', () => {
    mount('<button id="b" title="Delete">x</button><button id="c">c</button>');
    const b = el('#b');
    fireEvent.keyDown(document, { key: 'Tab' });
    b.focus();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toHaveTextContent('Delete');
    expect(b.getAttribute('title')).toBe('Delete');
    el('#c').focus();
    expect(tooltip()).toBeNull();
  });

  it('does not show for focus that follows a click', () => {
    mount('<button id="b" title="Delete">x</button>');
    const b = el('#b');
    fireEvent.pointerDown(b, { pointerType: 'mouse' });
    b.focus();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toBeNull();
  });

  it('Escape dismisses a focus tooltip', () => {
    mount('<button id="b" title="Delete">x</button>');
    fireEvent.keyDown(document, { key: 'Tab' });
    el('#b').focus();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip()).toBeNull();
  });

  it('hovering a focused trigger blanks its title and counts as a fresh hover after Escape', () => {
    mount('<button id="b" title="Delete">x</button><div id="away">away</div>');
    const b = el('#b');
    fireEvent.keyDown(document, { key: 'Tab' });
    b.focus();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip()).toBeNull();

    hover(b);
    expect(b.getAttribute('title')).toBe('');
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).toHaveTextContent('Delete');
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('Delete');
  });

  it('applies an app title change queued in the same tick as the hover of a focused trigger', async () => {
    mount('<button id="b" title="Old">x</button><div id="away">away</div>');
    const b = el('#b');
    fireEvent.keyDown(document, { key: 'Tab' });
    b.focus();
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    b.setAttribute('title', 'New'); // not yet delivered to the observer…
    hover(b); // …when the pointer arrives
    expect(b.getAttribute('title')).toBe('');
    expect(b.getAttribute(STASH_ATTR)).toBe('New');
    await flushMutations();
    expect(tooltip()).toHaveTextContent('New');
    hover(el('#away'));
    expect(b.getAttribute('title')).toBe('New');
  });
});

describe('global tooltip layer — placement wiring', () => {
  it('positions the bubble inside the viewport, flipped below a trigger at the top edge', () => {
    mount('<button id="b" title="Near the top-right corner">x</button>');
    const b = el('#b');
    vi.spyOn(b, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 1000, y: 2, width: 20, height: 20 }));
    hover(b);
    const bubble = document.getElementById(TOOLTIP_ID)!;
    vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 30 }));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(bubble.dataset.placement).toBe('bottom');
    const left = parseFloat(bubble.style.left);
    expect(left + 200).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(bubble.style.top)).toBe(2 + 20 + 8);
  });

  it('anchors a wide trigger at the pointer, also when sweeping straight from another trigger', () => {
    mount('<button id="a" title="Small">a</button><div id="wide" title="A whole row">row</div>');
    const wide = el('#wide');
    vi.spyOn(wide, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 300, width: 800, height: 30 }));
    const bubble = document.getElementById(TOOLTIP_ID)!;
    vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 30 }));
    hover(el('#a'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    hover(wide, { clientX: 700 }); // warm: shows at once
    expect(tooltip()).toHaveTextContent('A whole row');
    expect(parseFloat(bubble.style.left)).toBe(700 - 50);
  });
});

describe('installGlobalTooltips lifecycle', () => {
  it('uninstall restores a blanked title and removes the bubble', () => {
    mount('<button id="b" title="Delete">x</button>');
    hover(el('#b'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    uninstall();
    uninstall = () => {};
    expect(el('#b').getAttribute('title')).toBe('Delete');
    expect(document.getElementById(TOOLTIP_ID)).toBeNull();
  });

  it('a second concurrent install is a no-op (one listener set per document)', () => {
    mount('<button id="b" title="Delete">x</button>');
    const second = installGlobalTooltips();
    expect(document.querySelectorAll(`#${TOOLTIP_ID}`)).toHaveLength(1);
    second();
    hover(el('#b'));
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(tooltip()).not.toBeNull();
  });
});
