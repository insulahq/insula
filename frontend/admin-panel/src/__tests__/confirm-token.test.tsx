import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmToken from '@/components/ui/ConfirmToken';

describe('ConfirmToken', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  // `navigator.clipboard` is getter-only in jsdom, so assignment silently
  // fails (or throws) — it has to be redefined.
  function stubClipboard(fn: typeof writeText) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: fn },
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    writeText.mockClear();
    stubClipboard(writeText);
  });

  it('copies the exact token the operator has to type', async () => {
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(writeText);
    render(<ConfirmToken value="pvc-9f2c1a-longhorn" />);

    await user.click(screen.getByTestId('confirm-token'));

    expect(writeText).toHaveBeenCalledWith('pvc-9f2c1a-longhorn');
  });

  it('confirms the copy so the operator knows it worked', async () => {
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(writeText);
    render(<ConfirmToken value="node-a" />);

    await user.click(screen.getByTestId('confirm-token'));

    expect(screen.getByTestId('confirm-token')).toHaveAttribute('aria-label', 'Copied node-a');
  });

  it('stays usable when the clipboard is unavailable (insecure origin)', async () => {
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')) as typeof writeText);
    render(<ConfirmToken value="node-a" />);

    // Must not throw — the operator can still select the text by hand.
    await user.click(screen.getByTestId('confirm-token'));
    expect(screen.getByText('node-a')).toBeInTheDocument();
  });

  it('renders the token text verbatim so it can still be read and selected', () => {
    render(<ConfirmToken value="REPLACE" />);
    expect(screen.getByText('REPLACE')).toBeInTheDocument();
  });
});
