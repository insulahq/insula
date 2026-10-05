import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from '@/components/ui/Tooltip';
import { GlobalTooltips } from '@/components/ui/GlobalTooltips';
import { SHOW_DELAY_MS } from '@/lib/tooltip/tooltip-layer';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<Tooltip /> info hint', () => {
  it('carries its text as a plain title (no bubble of its own)', () => {
    render(<Tooltip text="Lowercase letters, digits and hyphens only." />);
    const hint = screen.getByTitle('Lowercase letters, digits and hyphens only.');
    expect(hint).toBe(screen.getByTestId('info-tooltip'));
    fireEvent.mouseEnter(hint);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('is a focusable image named "More information", described by the help text', () => {
    render(<Tooltip text="Locked once deployed." />);
    const hint = screen.getByRole('img', { name: 'More information' });
    expect(hint).toHaveAccessibleDescription('Locked once deployed.');
    expect(hint.tabIndex).toBe(0);
    expect(hint.className).toContain('focus-visible:ring-2');
    expect(hint.className).toContain('dark:focus-visible:ring-blue-400');
  });

  it('does not rename a <label> it sits in with the whole help text', () => {
    render(
      <label>
        <input type="checkbox" />
        Private registry
        <Tooltip text="A long help paragraph about registries." />
      </label>,
    );
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAccessibleName(/^Private registry ?More information$/);
    expect(checkbox).not.toHaveAccessibleName(/help paragraph/);
  });

  it('is drawn by the global layer like every other title — on hover', () => {
    const { unmount } = render(
      <>
        <GlobalTooltips />
        <Tooltip text="Locked once deployed." />
      </>,
    );
    fireEvent.pointerOver(screen.getByTestId('info-tooltip').firstElementChild!, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Locked once deployed.');
    unmount();
  });

  it('and on keyboard Tab', () => {
    const { unmount } = render(
      <>
        <GlobalTooltips />
        <Tooltip text="Locked once deployed." />
      </>,
    );
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => { screen.getByTestId('info-tooltip').focus(); });
    act(() => { vi.advanceTimersByTime(SHOW_DELAY_MS); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Locked once deployed.');
    unmount();
  });
});
