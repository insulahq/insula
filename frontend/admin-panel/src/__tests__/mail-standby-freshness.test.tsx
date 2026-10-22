import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MailStandbyFreshness, { MailStandbyPreparingNotice } from '../components/email/MailStandbyFreshness';

// Moving the mail standby to another node: the new node copies the whole store
// before it reports. The page says it is being prepared; the old node is gone
// from the tile instead of turning red.

let payload: { reports: unknown[]; preparing?: Array<{ node: string; since: string; state?: string; copyPercent?: number }> } = { reports: [] };
vi.mock('@/hooks/use-mail-standby-reports', () => ({
  useMailStandbyReports: () => ({ data: { data: payload }, isLoading: false, isError: false }),
}));

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const report = (node: string, ageSeconds: number) => ({
  node, sizeBytes: 44 * 2 ** 30, fileCount: 334, durationSeconds: 3, reportedAt: ago(ageSeconds), ageSeconds,
});
const wrap = (ui: ReactElement) => render(
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
);

beforeEach(() => { payload = { reports: [] }; });

describe('MailStandbyFreshness', () => {
  it('lists a standby still on its first copy as preparing, beside the fresh ones', () => {
    payload = { reports: [report('sv-b', 120)], preparing: [{ node: 'sv-c', since: ago(360) }] };
    wrap(<MailStandbyFreshness />);
    expect(screen.getByTestId('mail-standby-preparing-sv-c')).toHaveTextContent('first copy in progress — standby for 6 min');
    expect(screen.getByTestId('mail-standby-row-sv-b')).toBeInTheDocument();
  });

  it('shows how far the first copy is, once its copier reports it', () => {
    payload = { reports: [], preparing: [{ node: 'sv-c', since: ago(360), copyPercent: 47 }] };
    wrap(<MailStandbyFreshness />);
    expect(screen.getByTestId('mail-standby-preparing-sv-c')).toHaveTextContent('first copy in progress — 47% — standby for 6 min');
  });

  it('shows the tile while the only standby is preparing', () => {
    payload = { reports: [], preparing: [{ node: 'sv-c', since: ago(30) }] };
    wrap(<MailStandbyFreshness />);
    expect(screen.getByText('Standby data freshness')).toBeInTheDocument();
  });

  it('shows a first copy that stalled in red, saying why — not as in progress', () => {
    payload = {
      reports: [],
      preparing: [
        { node: 'sv-c', since: ago(15 * 60), state: 'not_running' },
        { node: 'sv-d', since: ago(7 * 3600), state: 'overdue' },
      ],
    };
    wrap(<MailStandbyFreshness />);
    expect(screen.getByTestId('mail-standby-preparing-sv-c')).toHaveTextContent('its copier is not running');
    expect(screen.getByTestId('mail-standby-preparing-sv-d')).toHaveTextContent('first copy not finished after 7 h 0 min');
    expect(screen.queryByText(/first copy in progress/)).toBeNull();
  });

  it('renders nothing without any standby', () => {
    const { container } = wrap(<MailStandbyFreshness />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads a backend without the preparing list', () => {
    payload = { reports: [report('sv-b', 60)] };
    wrap(<MailStandbyFreshness />);
    expect(screen.getByTestId('mail-standby-row-sv-b')).toBeInTheDocument();
  });
});

describe('MailStandbyPreparingNotice', () => {
  it('says the standby is being prepared, and what a failover would do meanwhile', () => {
    payload = { reports: [], preparing: [{ node: 'sv-c', since: ago(60) }] };
    wrap(<MailStandbyPreparingNotice />);
    const notice = screen.getByTestId('mail-standby-preparing-notice');
    expect(notice).toHaveTextContent('Preparing the standby on sv-c');
    expect(notice).toHaveTextContent('Mail keeps running meanwhile');
    expect(notice).toHaveTextContent('restores from the newest backup');
  });

  it('leaves out a first copy that stalled — that one is red in the list instead', () => {
    payload = { reports: [], preparing: [{ node: 'sv-c', since: ago(15 * 60), state: 'not_running' }] };
    const { container } = wrap(<MailStandbyPreparingNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is absent when no standby is preparing', () => {
    payload = { reports: [report('sv-b', 60)], preparing: [] };
    const { container } = wrap(<MailStandbyPreparingNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
