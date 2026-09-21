/**
 * Which retention field each schedule offers.
 *
 * The three DR artefacts keep a fixed NUMBER OF COPIES — the newest 24 etcd
 * snapshots, 30 secrets bundles, 14 cluster state dumps. Until now those
 * numbers were literals in the job scripts and the cards showed no retention
 * at all. They are settable now, so the count field appears.
 *
 * The days field must NOT: there is no time window behind it for these jobs,
 * and a control with nothing behind it is the exact failure this area has had
 * twice (the mail snapshot's retention, then the tenant bundles' keep-last-N).
 *
 * It is conditionally rendered rather than CSS-hidden on purpose — a hidden
 * input still holds a draft and still goes out on save, which is how an
 * operator ends up having changed something they were never shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn(async (url: string) => {
  const sub = url.split('/backups/schedules/')[1] ?? 'x';
  return { data: { subsystem: sub, enabled: true, cronExpression: '0 * * * *', retentionDays: null, retentionCount: 24, gateSatisfied: true } };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string])) }));

const ScheduleCard = (await import('@/components/backups/ScheduleCard')).default;

type CardProps = Parameters<typeof ScheduleCard>[0];

function renderCard(props: CardProps) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ScheduleCard {...props} />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());

describe('retention fields per schedule', () => {
  it('a copies-based schedule offers the count and NOT the days', async () => {
    renderCard({ subsystem: 'etcd_snapshot', title: 'etcd', description: 'd', hideRetentionDays: true });
    await waitFor(() => expect(screen.getByTestId('schedule-retention-count-etcd_snapshot')).toBeInTheDocument());
    expect(screen.queryByTestId('schedule-retention-days-etcd_snapshot')).toBeNull();
  });

  it('the days input is absent from the DOM, not merely invisible', async () => {
    // A hidden-but-present input still submits its draft on save.
    const { container } = renderCard({ subsystem: 'secrets_bundle', title: 's', description: 'd', hideRetentionDays: true });
    await waitFor(() => expect(screen.getByTestId('schedule-retention-count-secrets_bundle')).toBeInTheDocument());
    expect(container.querySelector('#retdays-secrets_bundle')).toBeNull();
  });

  it('a window-based schedule still offers both', async () => {
    renderCard({ subsystem: 'mail', title: 'mail', description: 'd' });
    await waitFor(() => expect(screen.getByTestId('schedule-retention-days-mail')).toBeInTheDocument());
    expect(screen.getByTestId('schedule-retention-count-mail')).toBeInTheDocument();
  });

  it('a schedule with no settable retention offers neither', async () => {
    renderCard({ subsystem: 'longhorn_recurring', title: 'lh', description: 'd', hideRetention: true });
    await waitFor(() => expect(screen.getByTestId('schedule-card-longhorn_recurring')).toBeInTheDocument());
    expect(screen.queryByTestId('schedule-retention-count-longhorn_recurring')).toBeNull();
    expect(screen.queryByTestId('schedule-retention-days-longhorn_recurring')).toBeNull();
  });
});
