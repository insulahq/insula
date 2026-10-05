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

  it('is drawn by the global layer like every other title', () => {
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
});
