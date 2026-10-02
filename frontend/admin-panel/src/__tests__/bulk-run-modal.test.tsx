import { StrictMode } from 'react';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import BulkRunModal from '@/components/BulkRunModal';
import { useBulkRun, type BulkRunConfig } from '@/hooks/use-bulk-run';
import type { BulkItemOutcome, BulkRunItem } from '@/lib/bulk-run';

/**
 * The bulk-progress modal and its sequential runner, driven through a harness
 * whose `runItem` the test controls — each call returns a promise the test
 * settles, so "what has been issued so far" is observable at every step.
 */

const ITEMS: readonly BulkRunItem[] = [
  { id: 'a', label: 'alpha.example.test', sublabel: 'Tenant A' },
  { id: 'b', label: 'bravo.example.test' },
  { id: 'c', label: 'charlie.example.test' },
];

interface Held {
  readonly id: string;
  readonly resolve: (o: BulkItemOutcome) => void;
  readonly reject: (e: unknown) => void;
}

function heldRunner() {
  const calls: Held[] = [];
  const runItem = vi.fn((item: BulkRunItem) => new Promise<BulkItemOutcome>((resolve, reject) => {
    calls.push({ id: item.id, resolve, reject });
  }));
  return { calls, runItem };
}

function Harness({ config }: { readonly config: BulkRunConfig<BulkRunItem> }) {
  const run = useBulkRun();
  return (
    <>
      <button type="button" onClick={() => run.start(config)}>start</button>
      <BulkRunModal controller={run} />
    </>
  );
}

function statusOf(id: string): string | null {
  return screen.getByTestId(`bulk-run-row-${id}`).getAttribute('data-status');
}

/** Lets any wrongly-eager loop issue its next request before we look. */
async function settleMicrotasks() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('BulkRunModal + useBulkRun', () => {
  it('issues one request at a time: the second is not sent while the first is unresolved', async () => {
    const user = userEvent.setup();
    const { calls, runItem } = heldRunner();
    render(<Harness config={{ title: 'Refresh route DNS', noun: 'domain', items: ITEMS, runItem }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(runItem).toHaveBeenCalledTimes(1));
    await settleMicrotasks();

    expect(runItem).toHaveBeenCalledTimes(1);
    expect(statusOf('a')).toBe('running');
    expect(statusOf('b')).toBe('queued');
    expect(statusOf('c')).toBe('queued');

    act(() => calls[0].resolve({ status: 'succeeded', detail: 'done a' }));
    await waitFor(() => expect(runItem).toHaveBeenCalledTimes(2));
    await settleMicrotasks();
    expect(runItem).toHaveBeenCalledTimes(2);
    expect(runItem.mock.calls[1][0].id).toBe('b');
    expect(statusOf('a')).toBe('succeeded');
    expect(statusOf('b')).toBe('running');

    act(() => calls[1].resolve({ status: 'skipped', detail: 'skip b' }));
    await waitFor(() => expect(runItem).toHaveBeenCalledTimes(3));
    act(() => calls[2].resolve({ status: 'succeeded' }));

    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('2 succeeded, 1 skipped, 0 failed'));
    expect(screen.getByTestId('bulk-run-detail-a')).toHaveTextContent('done a');
    expect(screen.getByTestId('bulk-run-detail-b')).toHaveTextContent('skip b');
    expect(screen.getByTestId('bulk-run-progress')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.queryByTestId('bulk-run-error')).not.toBeInTheDocument();
  });

  it('keeps Close disabled until the run finishes', async () => {
    const user = userEvent.setup();
    const { calls, runItem } = heldRunner();
    const onClose = vi.fn();
    render(<Harness config={{ title: 'Verify', noun: 'domain', items: ITEMS.slice(0, 1), runItem, onClose }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(runItem).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('bulk-run-close')).toBeDisabled();
    expect(screen.getByLabelText('Close')).toBeDisabled();

    act(() => calls[0].resolve({ status: 'succeeded' }));
    await waitFor(() => expect(screen.getByTestId('bulk-run-close')).toBeEnabled());
    await user.click(screen.getByTestId('bulk-run-close'));

    expect(screen.queryByTestId('bulk-run-modal')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledWith([]);
  });

  it('cancel stops before the next item, lets the in-flight one finish, and marks the rest not run', async () => {
    const user = userEvent.setup();
    const { calls, runItem } = heldRunner();
    const onClose = vi.fn();
    const onSettled = vi.fn();
    render(<Harness config={{ title: 'Delete', noun: 'domain', items: ITEMS, runItem, onClose, onSettled }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(runItem).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId('bulk-run-cancel'));

    expect(screen.getByTestId('bulk-run-cancel')).toHaveTextContent('Cancelling');
    expect(screen.getByTestId('bulk-run-close')).toBeDisabled();
    expect(statusOf('a')).toBe('running');

    act(() => calls[0].resolve({ status: 'succeeded' }));
    await waitFor(() => expect(screen.getByTestId('bulk-run-close')).toBeEnabled());
    await settleMicrotasks();

    expect(runItem).toHaveBeenCalledTimes(1);
    expect(statusOf('a')).toBe('succeeded');
    expect(statusOf('b')).toBe('cancelled');
    expect(statusOf('c')).toBe('cancelled');
    expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('1 succeeded, 0 skipped, 0 failed, 2 not run (cancelled)');
    expect(onSettled).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('bulk-run-close'));
    expect(onClose).toHaveBeenCalledWith(['b', 'c']);
  });

  it('a thrown error fails only that row and the run continues', async () => {
    const user = userEvent.setup();
    const runItem = vi.fn(async (item: BulkRunItem): Promise<BulkItemOutcome> => {
      if (item.id === 'b') throw new Error('upstream exploded');
      return { status: 'succeeded' };
    });
    render(<Harness config={{ title: 'Enable', noun: 'cron job', items: ITEMS, runItem }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('2 succeeded, 0 skipped, 1 failed'));
    expect(runItem).toHaveBeenCalledTimes(3);
    expect(statusOf('b')).toBe('failed');
    expect(screen.getByTestId('bulk-run-detail-b')).toHaveTextContent('upstream exploded');
  });

  it('renders a partial failure as BULK_PARTIAL_FAILURE and "Retry failed" re-runs only the failures', async () => {
    const user = userEvent.setup();
    let pass = 1;
    const runItem = vi.fn(async (item: BulkRunItem): Promise<BulkItemOutcome> => {
      if (pass === 1 && item.id !== 'b') {
        return { status: 'failed', detail: `${item.id} broke`, lines: [`${item.id}.www: provider timeout`] };
      }
      return { status: 'succeeded', detail: `${item.id} ok` };
    });
    const onSettled = vi.fn();
    const onClose = vi.fn();
    render(<Harness config={{ title: 'Refresh route DNS', noun: 'domain', items: ITEMS, runItem, onSettled, onClose }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('1 succeeded, 0 skipped, 2 failed'));
    // Invalidation happens once per pass, never per item.
    expect(onSettled).toHaveBeenCalledTimes(1);

    const panel = screen.getByTestId('bulk-run-error');
    expect(within(panel).getByText('BULK_PARTIAL_FAILURE')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Refresh route DNS: 2 of 3 domains failed');
    expect(within(screen.getByTestId('bulk-run-row-a')).getByText('a.www: provider timeout')).toBeInTheDocument();

    pass = 2;
    runItem.mockClear();
    await user.click(screen.getByTestId('bulk-run-retry-failed'));

    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('3 succeeded, 0 skipped, 0 failed'));
    expect(runItem.mock.calls.map(([item]) => item.id)).toEqual(['a', 'c']);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('bulk-run-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bulk-run-retry-failed')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('bulk-run-close'));
    expect(onClose).toHaveBeenCalledWith([]);
  });

  it('hands the failed ids to onClose so the caller can keep them selected', async () => {
    const user = userEvent.setup();
    const runItem = vi.fn(async (item: BulkRunItem): Promise<BulkItemOutcome> => (
      item.id === 'c' ? { status: 'failed', detail: 'nope' } : { status: 'skipped' }
    ));
    const onClose = vi.fn();
    render(<Harness config={{ title: 'Suspend', noun: 'tenant', items: ITEMS, runItem, onClose }} />);

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('bulk-run-close')).toBeEnabled());
    await user.click(screen.getByTestId('bulk-run-close'));
    expect(onClose).toHaveBeenCalledWith(['c']);
  });

  it('under StrictMode each item is still requested exactly once', async () => {
    const user = userEvent.setup();
    const runItem = vi.fn(async (_item: BulkRunItem): Promise<BulkItemOutcome> => ({ status: 'succeeded' }));
    render(
      <StrictMode>
        <Harness config={{ title: 'Verify', noun: 'domain', items: ITEMS, runItem }} />
      </StrictMode>,
    );

    await user.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('bulk-run-summary')).toHaveTextContent('3 succeeded'));
    expect(runItem.mock.calls.map(([item]) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
