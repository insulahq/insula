import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GlobalTooltips } from '@/components/ui/GlobalTooltips';
import { SHOW_DELAY_MS, TOOLTIP_ID } from '@/lib/tooltip/tooltip-layer';

/*
 * The layer driven through React: the title is a React prop, so React — not
 * the test — rewrites or removes it while the tooltip is up.
 */

function Probe({ title }: { title?: string }) {
  return (
    <>
      <GlobalTooltips />
      <button type="button" title={title}>
        <svg aria-hidden="true" />
      </button>
      <p>elsewhere</p>
    </>
  );
}

function hover(target: Element): void {
  fireEvent.pointerOver(target, { pointerType: 'mouse' });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<GlobalTooltips />', () => {
  it('renders a React title as the styled tooltip and cleans up on unmount', () => {
    const { unmount } = render(<Probe title="Rotate password" />);
    const button = screen.getByRole('button', { name: 'Rotate password' });
    hover(button);
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Rotate password');
    expect(screen.getByRole('button', { name: 'Rotate password' })).toBe(button);

    unmount();
    expect(document.getElementById(TOOLTIP_ID)).toBeNull();
    expect(button.getAttribute('title')).toBe('Rotate password');
  });

  it('installs exactly one layer under StrictMode double-mount', () => {
    const { unmount } = render(
      <StrictMode>
        <Probe title="Rotate password" />
      </StrictMode>,
    );
    expect(document.querySelectorAll(`#${TOOLTIP_ID}`)).toHaveLength(1);
    hover(screen.getByRole('button'));
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    unmount();
    expect(document.getElementById(TOOLTIP_ID)).toBeNull();
  });

  it('follows a title prop that changes while shown', async () => {
    const { rerender, unmount } = render(<Probe title="Pending" />);
    const button = screen.getByRole('button');
    hover(button);
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    rerender(<Probe title="Ready" />);
    await settle();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ready');
    hover(screen.getByText('elsewhere'));
    expect(button.getAttribute('title')).toBe('Ready');
    unmount();
  });

  it('does not resurrect a title prop React removed while shown', async () => {
    const { rerender, unmount } = render(<Probe title="Disabled: needs super_admin" />);
    const button = screen.getByRole('button');
    hover(button);
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    rerender(<Probe />);
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
    hover(screen.getByText('elsewhere'));
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.hasAttribute('aria-label')).toBe(false);
    unmount();
  });
});
