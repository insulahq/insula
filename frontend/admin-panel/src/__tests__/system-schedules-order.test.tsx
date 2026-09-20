/**
 * System Backups → "Targets, Schedules & Retention": what is listed, and in
 * what order.
 *
 * Two operator-driven changes this pins:
 *
 *  1. The platform database comes FIRST under Schedules. It used to render in
 *     its own section BELOW every other schedule, which put the one backup the
 *     platform cannot be rebuilt without at the bottom of the page, under
 *     three DR artefacts that are worthless without it.
 *
 *  2. The Longhorn recurring-snapshot card is gone. Its cadence is compiled
 *     into a Flux-managed RecurringJob the platform neither owns nor holds
 *     RBAC for, so the card could only ever display the value and refuse to
 *     change it — controls that exist to say no.
 *
 * The other three cards stay, and the etcd one keeps its cron input: an edit
 * there really does repatch the CronJob (`cronjob-owned`, Flux reconciliation
 * disabled on that object), verified against a live cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const apiFetch = vi.fn(async (url: string) => {
  if (url.includes('/backups/schedules/')) {
    const sub = url.split('/backups/schedules/')[1];
    return { data: { subsystem: sub, enabled: true, cronExpression: '0 * * * *', retentionDays: null, retentionCount: null, gateSatisfied: true } };
  }
  if (url.includes('/shim/assignments')) return { data: { assignments: [] } };
  if (url.includes('/backup-configurations')) return { data: [] };
  if (url.includes('/wal-archive') || url.includes('/postgres')) return { data: {} };
  return { data: [] };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string])) }));
vi.mock('@/components/system-backup/PostgresBackupsSection', () => ({
  default: () => <div data-testid="stub-postgres-section">Platform database backups</div>,
}));

const BackupRoutingTab = (await import('@/pages/backups/BackupRoutingTab')).default;

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BackupRoutingTab shimClass="system" scheduleSubsystems={['etcd_snapshot', 'secrets_bundle', 'cluster_state']} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('system schedules', () => {
  it('puts the platform database first, above the DR artefacts', async () => {
    const { container } = renderTab();
    await waitFor(() => expect(screen.getByTestId('schedule-card-etcd_snapshot')).toBeInTheDocument());
    const text = container.textContent ?? '';
    const db = text.indexOf('Platform database backups');
    const etcd = text.indexOf('etcd snapshot upload');
    expect(db).toBeGreaterThanOrEqual(0);
    expect(etcd).toBeGreaterThanOrEqual(0);
    expect(db).toBeLessThan(etcd);
  });

  it('renders the database inside the Schedules section, not in one of its own', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('stub-postgres-section')).toBeInTheDocument());
    const schedules = screen.getByTestId('routing-tab-schedules');
    expect(schedules).toContainElement(screen.getByTestId('stub-postgres-section'));
  });

  it('no longer offers a Longhorn recurring-snapshot card', async () => {
    const { container } = renderTab();
    await waitFor(() => expect(screen.getByTestId('stub-postgres-section')).toBeInTheDocument());
    expect(container.textContent).not.toContain('Longhorn recurring snapshots');
  });

  it('keeps the three DR schedules, etcd included', async () => {
    const { container } = renderTab();
    await waitFor(() => expect(screen.getByTestId('schedule-card-cluster_state')).toBeInTheDocument());
    for (const t of ['etcd snapshot upload', 'Secrets bundle', 'Cluster state dump']) {
      expect(container.textContent).toContain(t);
    }
  });

  it('counts the database alongside the schedules in the section heading', async () => {
    // Three cards plus the database. A heading that said (3) would be
    // describing a section with four things in it.
    const { container } = renderTab();
    await waitFor(() => expect(screen.getByTestId('stub-postgres-section')).toBeInTheDocument());
    expect(container.textContent).toContain('(4)');
  });
});
