import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SnapshotRestoreStatus, SnapshotRestoreStep } from '@insula/api-contracts';
import SnapshotRestoreProgressModal, { formatDuration } from '../components/SnapshotRestoreProgressModal';
import { restorePollInterval } from '../hooks/use-snapshots';
import { formatDataSize, formatVolumeSize } from '../lib/format-snapshot-size';

let statusResult: { data?: { data: SnapshotRestoreStatus }; isError: boolean; error?: unknown } = { isError: false };

vi.mock('../hooks/use-snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-snapshots')>();
  return { ...actual, useRestoreStatus: vi.fn(() => statusResult) };
});

const startedAt = new Date(Date.now() - 30_000).toISOString();

function step(key: SnapshotRestoreStep['key'], label: string, state: SnapshotRestoreStep['state'], over: Partial<SnapshotRestoreStep> = {}): SnapshotRestoreStep {
  const done = state === 'succeeded' || state === 'failed';
  return {
    key, label, state,
    startedAt: state === 'pending' || state === 'skipped' ? null : startedAt,
    finishedAt: done ? startedAt : null,
    elapsedMs: done ? 4_000 : null,
    detail: null,
    ...over,
  };
}

function status(over: Partial<SnapshotRestoreStatus>): SnapshotRestoreStatus {
  return {
    operationId: 'op-123e4567', state: 'restoring', outcome: 'running', progressPct: 58,
    progressMessage: 'Wait for the volume to be ready…', lastError: null, error: null,
    snapshotLabel: 'before plugin update', startedAt, completedAt: null,
    steps: [
      step('quiesce', 'Stop workloads', 'succeeded'),
      step('wait-detach', 'Release the storage volume', 'succeeded'),
      step('attach-maintenance', 'Attach the volume for the restore', 'succeeded'),
      step('wait-maintenance', 'Wait for the volume to be ready', 'running'),
      step('revert', 'Revert the volume to the snapshot', 'pending'),
      step('detach-maintenance', 'Detach the volume', 'pending'),
      step('unquiesce', 'Start workloads again', 'pending'),
    ],
    ...over,
  };
}

describe('SnapshotRestoreProgressModal (tenant)', () => {
  beforeEach(() => { statusResult = { isError: false }; });

  it('★ renders every step with its own state while the restore runs', () => {
    statusResult = { data: { data: status({}) }, isError: false };
    render(<SnapshotRestoreProgressModal operationId="op-123e4567" onClose={() => {}} />);
    const timeline = screen.getByTestId('restore-step-timeline');
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByTestId('restore-step-quiesce').getAttribute('data-state')).toBe('succeeded');
    expect(screen.getByTestId('restore-step-wait-maintenance').getAttribute('data-state')).toBe('running');
    expect(screen.getByTestId('restore-step-revert').getAttribute('data-state')).toBe('pending');
    expect(screen.getByTestId('restore-progress-msg').textContent).toBe('Step 4 of 7 — Wait for the volume to be ready');
    // Finished steps carry their duration.
    expect(screen.getByTestId('restore-step-quiesce').textContent).toContain('4s');
    expect(screen.getByText('“before plugin update”')).toBeInTheDocument();
  });

  it('names the recovery after a failure without a step number', () => {
    const base = status({});
    statusResult = {
      data: {
        data: status({
          steps: [
            { ...base.steps[0]!, state: 'failed' },
            ...base.steps.slice(1).map((s) => ({ ...s, state: 'skipped' as const, startedAt: null })),
            step('recover', 'Start workloads again after the failure', 'running'),
          ],
        }),
      },
      isError: false,
    };
    render(<SnapshotRestoreProgressModal operationId="op-1" onClose={() => {}} />);
    expect(screen.getByTestId('restore-progress-msg').textContent).toBe('Restore failed — start workloads again after the failure');
  });

  it('cannot be closed while the restore runs', () => {
    const onClose = vi.fn();
    statusResult = { data: { data: status({}) }, isError: false };
    render(<SnapshotRestoreProgressModal operationId="op-1" onClose={onClose} />);
    const close = screen.getByTestId('restore-close');
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the completed state and lets the tenant close it', () => {
    const onClose = vi.fn();
    statusResult = {
      data: {
        data: status({
          state: 'idle', outcome: 'succeeded', progressPct: 100, completedAt: new Date().toISOString(),
          steps: status({}).steps.map((s) => ({ ...s, state: 'succeeded', elapsedMs: 1000 })),
        }),
      },
      isError: false,
    };
    render(<SnapshotRestoreProgressModal operationId="op-1" onClose={onClose} />);
    expect(screen.getByTestId('restore-done')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('restore-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('★ renders a failure through ErrorPanel, with the failed step marked', () => {
    statusResult = {
      data: {
        data: status({
          state: 'failed', outcome: 'failed', completedAt: new Date().toISOString(),
          lastError: 'Your files were not changed.',
          error: {
            code: 'SNAPSHOT_RESTORE_FAILED',
            title: 'Restore failed',
            detail: 'Your files were not changed — the restore stopped at “Wait for the volume to be ready”, before anything was reverted. Your site was started again.',
            remediation: ['Try the restore again — the snapshot is still available.'],
            retryable: true,
            diagnostics: { operationId: 'op-123e4567' },
          },
          steps: [
            step('quiesce', 'Stop workloads', 'succeeded'),
            step('wait-maintenance', 'Wait for the volume to be ready', 'failed'),
            step('revert', 'Revert the volume to the snapshot', 'skipped'),
            step('recover', 'Start workloads again after the failure', 'succeeded'),
          ],
        }),
      },
      isError: false,
    };
    render(<SnapshotRestoreProgressModal operationId="op-123e4567" onClose={() => {}} />);
    const panel = screen.getByTestId('restore-failed');
    expect(panel).toHaveAttribute('role', 'alert');
    expect(panel.textContent).toContain('Restore failed');
    expect(panel.textContent).toContain('Your files were not changed');
    expect(panel.textContent).toContain('SNAPSHOT_RESTORE_FAILED');
    expect(screen.getByTestId('restore-step-wait-maintenance').getAttribute('data-state')).toBe('failed');
    expect(screen.getByTestId('restore-step-revert').getAttribute('data-state')).toBe('skipped');
    expect(screen.getByTestId('restore-operation-id').textContent).toBe('op-123e4567');
    expect(screen.getByTestId('restore-close')).not.toBeDisabled();
  });

  it('never prints a step detail the server did not send (tenant view has none)', () => {
    statusResult = { data: { data: status({}) }, isError: false };
    const { container } = render(<SnapshotRestoreProgressModal operationId="op-1" onClose={() => {}} />);
    expect(container.querySelectorAll('.font-mono.break-all')).toHaveLength(0);
  });

  it('a status that cannot be loaded shows an ErrorPanel and stays closable', () => {
    statusResult = { isError: true, error: new Error('Network down') };
    render(<SnapshotRestoreProgressModal operationId="op-1" onClose={() => {}} />);
    expect(screen.getByTestId('restore-status-load-error').textContent).toContain('Network down');
    expect(screen.getByTestId('restore-close')).not.toBeDisabled();
  });

  it('falls back to the bar and message for a restore with no step timeline', () => {
    statusResult = { data: { data: status({ steps: [], progressMessage: 'Scaling workloads to zero' }) }, isError: false };
    render(<SnapshotRestoreProgressModal operationId="op-1" onClose={() => {}} />);
    expect(screen.queryByTestId('restore-step-timeline')).toBeNull();
    expect(screen.getByTestId('restore-progress-msg').textContent).toBe('Scaling workloads to zero');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '58');
  });
});

describe('restore helpers', () => {
  it('polls while running, stops when terminal, backs off after an error', () => {
    expect(restorePollInterval(status({}), 'success')).toBe(2000);
    expect(restorePollInterval(status({ outcome: 'succeeded' }), 'success')).toBe(false);
    expect(restorePollInterval(status({ outcome: 'failed' }), 'success')).toBe(false);
    expect(restorePollInterval(undefined, 'pending')).toBe(2000);
    expect(restorePollInterval(undefined, 'error')).toBe(5000);
  });

  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 05s');
  });

  it('★ keeps "not measured" and "measured zero" apart', () => {
    expect(formatDataSize(null)).toBe('—');
    expect(formatDataSize(0)).toBe('0 B');
    expect(formatDataSize(67399680)).toBe('64.3 MB');
    // Volume size 0 means "not known yet" (still creating).
    expect(formatVolumeSize(0)).toBe('—');
    expect(formatVolumeSize(2147483648)).toBe('2.0 GB');
  });
});
