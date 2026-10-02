/**
 * The migration progress modal shows how long each step took — a DR failover
 * of an almost-empty store took ~4.5 min on a VM drill and nothing said where
 * the time went.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MailMigrationStatusResponse } from '@insula/api-contracts';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';

let mockStatus: MailMigrationStatusResponse;
vi.mock('@/hooks/use-mail-migration', () => ({
  useMailMigrationStatus: () => ({ data: { data: mockStatus }, isLoading: false, isError: false }),
  useCancelMailMigration: () => ({ mutate: vi.fn(), isPending: false }),
}));

const base = {
  runId: '78030765-8b08-4b67-b681-24eeb7b107ee', sourceNode: 'node-a', targetNode: 'node-b',
  progressBytes: null, startedAt: '2026-10-02T15:55:40.000Z', error: null,
} as const;

describe('MailMigrationProgressModal — step durations', () => {
  it('shows the time each finished step took', () => {
    mockStatus = {
      ...base, state: 'done', currentStep: 'complete', finishedAt: '2026-10-02T15:58:00.000Z',
      stepTimings: [
        { step: 'preflight', at: '2026-10-02T15:55:40.000Z', seconds: 1.5 },
        { step: 'scaling-down', at: '2026-10-02T15:55:41.500Z', seconds: 90.5 },
        { step: 'done', at: '2026-10-02T15:58:00.000Z', seconds: null },
      ],
    } as MailMigrationStatusResponse;
    render(<MailMigrationProgressModal runId={base.runId} onClose={() => {}} />);
    expect(screen.getByText('1.5s')).toBeInTheDocument();
    expect(screen.getByText('1m 31s')).toBeInTheDocument();
  });

  it('a run from before step timings existed renders without durations', () => {
    mockStatus = { ...base, state: 'done', currentStep: 'complete', finishedAt: '2026-10-02T15:58:00.000Z' } as MailMigrationStatusResponse;
    render(<MailMigrationProgressModal runId={base.runId} onClose={() => {}} />);
    expect(screen.getByText('node-b')).toBeInTheDocument(); // the run rendered at all
    expect(screen.queryByText(/^\d+(\.\d)?s$/)).toBeNull();
  });
});
