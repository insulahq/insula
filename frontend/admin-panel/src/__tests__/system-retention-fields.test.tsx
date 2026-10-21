/**
 * Every schedule with settable retention offers BOTH limits, under one rule:
 * a copy is removed when it is older than the days or not among the newest N —
 * whichever comes first (backup-schedules/retention-policy.ts).
 *
 * The DR artefacts used to offer the count only, because their jobs pruned by
 * count and nothing pruned by days. platform-api now enforces both for them
 * (dr-artefact-retention.ts), so the days field has something behind it.
 *
 * A schedule with no settable retention renders neither field — absent from
 * the DOM, not CSS-hidden: a hidden input still holds a draft and goes out on
 * save, which is how an operator changes something they were never shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetch = vi.fn(async (url: string, _init?: RequestInit) => {
  const sub = url.split('/backups/schedules/')[1] ?? 'x';
  return { data: { subsystem: sub, enabled: true, cronExpression: '0 * * * *', retentionDays: null, retentionCount: 24, gateSatisfied: true } };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string, RequestInit?])) }));

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
  it.each(['etcd_snapshot', 'secrets_bundle', 'cluster_state', 'mail', 'tenant_bundle'] as const)(
    '%s offers both the days and the count, and states the rule',
    async (subsystem) => {
      renderCard({ subsystem, title: 't', description: 'd' });
      await waitFor(() => expect(screen.getByTestId(`schedule-retention-count-${subsystem}`)).toBeInTheDocument());
      expect(screen.getByTestId(`schedule-retention-days-${subsystem}`)).toBeInTheDocument();
      expect(screen.getByTestId(`schedule-retention-rule-${subsystem}`)).toHaveTextContent('whichever comes first');
    },
  );

  it('says what the saved values keep, and what a draft would keep', async () => {
    renderCard({ subsystem: 'secrets_bundle', title: 's', description: 'd' });
    const summary = await screen.findByTestId('schedule-retention-summary-secrets_bundle');
    expect(summary).toHaveTextContent('Keeps at most the newest 24');
    fireEvent.change(screen.getByTestId('schedule-retention-days-secrets_bundle'), { target: { value: '14' } });
    expect(screen.getByTestId('schedule-retention-summary-secrets_bundle'))
      .toHaveTextContent('After saving, keeps copies from the last 14 days, and at most the newest 24');
  });

  it('refuses a change that leaves no limit at all', async () => {
    renderCard({ subsystem: 'cluster_state', title: 'c', description: 'd' });
    const count = await screen.findByTestId('schedule-retention-count-cluster_state');
    fireEvent.change(count, { target: { value: '' } });
    expect(screen.getByTestId('schedule-combined-error-cluster_state')).toHaveTextContent('with neither, nothing would ever be removed');
    expect(screen.getByTestId('schedule-save-cluster_state')).toBeDisabled();
    // Zero is "no limit" too.
    fireEvent.change(count, { target: { value: '0' } });
    expect(screen.getByTestId('schedule-save-cluster_state')).toBeDisabled();
    // One limit is enough.
    fireEvent.change(screen.getByTestId('schedule-retention-days-cluster_state'), { target: { value: '30' } });
    expect(screen.queryByTestId('schedule-combined-error-cluster_state')).toBeNull();
    expect(screen.getByTestId('schedule-save-cluster_state')).toBeEnabled();
  });

  it('sends only the retention field that changed', async () => {
    renderCard({ subsystem: 'etcd_snapshot', title: 'e', description: 'd' });
    fireEvent.change(await screen.findByTestId('schedule-retention-days-etcd_snapshot'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('schedule-save-etcd_snapshot'));
    await waitFor(() => expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const patch = apiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ retentionDays: 7 });
  });

  it('a schedule with no settable retention offers neither', async () => {
    renderCard({ subsystem: 'longhorn_recurring', title: 'lh', description: 'd', hideRetention: true });
    await waitFor(() => expect(screen.getByTestId('schedule-card-longhorn_recurring')).toBeInTheDocument());
    expect(screen.queryByTestId('schedule-retention-count-longhorn_recurring')).toBeNull();
    expect(screen.queryByTestId('schedule-retention-days-longhorn_recurring')).toBeNull();
    expect(screen.queryByTestId('schedule-retention-rule-longhorn_recurring')).toBeNull();
  });
});
