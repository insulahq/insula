/**
 * The cron input has to say which clock it means.
 *
 * `backup_schedules` crons are wall-clock times in the platform's configured
 * zone — the same zone the platform stamps into every CronJob's
 * `spec.timeZone`. Unlabelled, `30 3 * * *` reads as UTC to one operator and
 * as local to another, and on a UTC+2 cluster those are two hours apart. An
 * operator set exactly that and reported it "only running at 05:30".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const settings: { timezone: string | null } = { timezone: 'Africa/Windhoek' };

// The fixture drives the `mail` card rather than `tenant_bundle`: the zone
// label lives in ScheduleCard and is identical for every subsystem, and
// `tenant_bundle` is a legacy backup_class string that ci-no-legacy-backup-
// classes.sh greps for. Keeping it out of the fixture leaves that guard tight.
const apiFetch = vi.fn(async (url: string) => {
  if (url.includes('/system-settings')) return { data: { ...settings } };
  if (url.includes('/backups/schedules/')) {
    return {
      data: {
        subsystem: 'mail', enabled: true, cronExpression: '30 3 * * *',
        retentionDays: 30, retentionCount: null, gateSatisfied: true,
      },
    };
  }
  return { data: [] };
});
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [string])) }));

const { default: ScheduleCard } = await import('@/components/backups/ScheduleCard');

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScheduleCard subsystem="mail" title="Mail snapshots" description="" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ScheduleCard — schedule timezone', () => {
  beforeEach(() => { settings.timezone = 'Africa/Windhoek'; });

  it('names the zone beside the cron field', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('schedule-cron-mail')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Cron expression \(Africa\/Windhoek\)/)).toBeInTheDocument());
  });

  it('spells out that the value is wall-clock time in that zone', async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByText(/wall-clock time in Africa\/Windhoek/)).toBeInTheDocument(),
    );
  });

  it('degrades to the bare label when no zone is configured', async () => {
    // Never render "Cron expression ()" — an empty parenthetical reads as a
    // bug and tells the operator nothing.
    settings.timezone = null;
    mount();
    await waitFor(() => expect(screen.getByTestId('schedule-cron-mail')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/^Cron expression$/)).toBeInTheDocument());
    expect(screen.queryByText(/wall-clock time in/)).toBeNull();
  });
});
