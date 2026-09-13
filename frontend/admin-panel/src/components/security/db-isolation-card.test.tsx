/**
 * Database connection-isolation card + detail table (ROADMAP R36).
 *
 * The behaviour worth pinning is the THREE-state rendering. `null` means the
 * CNPG primary could not be reached or the read-back could not be parsed, and
 * it must render as "unknown" — never as the safe state. A posture card that
 * shows a failed readout as a clean bill of health is worse than no card,
 * because it actively discourages the person who would otherwise go look.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DatabaseIsolationCard, DatabaseIsolationTable } from '../../pages/PosturePage';

const db = (datname: string, publicConnect: boolean, grantees: string[] = [datname]) => ({
  datname,
  owner: datname,
  publicConnect,
  connectGrantees: grantees,
});

describe('DatabaseIsolationCard', () => {
  it('renders an unreadable state as unknown, not as isolated', () => {
    render(<DatabaseIsolationCard isolation={null} />);
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByText(/not a clean bill of health/)).toBeTruthy();
  });

  it('reports the fully-isolated cluster as OK', () => {
    render(
      <DatabaseIsolationCard
        isolation={{
          databases: [
            db('platform', false, ['platform', 'cnpg_metrics_exporter']),
            db('crowdsec', false, ['crowdsec', 'cnpg_metrics_exporter']),
          ],
          atRisk: [],
        }}
      />,
    );
    expect(screen.getByText('2 / 2 isolated')).toBeTruthy();
    expect(screen.getByText(/Every database refuses PUBLIC/)).toBeTruthy();
  });

  it('names the databases that are still open', () => {
    render(
      <DatabaseIsolationCard
        isolation={{ databases: [db('platform', true), db('crowdsec', false)], atRisk: [] }}
      />,
    );
    expect(screen.getByText('1 / 2 isolated')).toBeTruthy();
    expect(screen.getByText(/PUBLIC still holds CONNECT on: platform/)).toBeTruthy();
  });

  it('prioritises an at-risk role over the open-database message', () => {
    // A role that can no longer reconnect is the more urgent of the two: the
    // open database is the pre-existing state, the lockout is something the
    // last apply just caused.
    render(
      <DatabaseIsolationCard
        isolation={{
          databases: [db('platform', true)],
          atRisk: [{ datname: 'platform', usename: 'roundcube' }],
        }}
      />,
    );
    expect(screen.getByText(/1 connected role\(s\) cannot reconnect/)).toBeTruthy();
  });
});

describe('DatabaseIsolationTable', () => {
  it('renders nothing when every database is isolated', () => {
    // Four green rows on every page load trains people to stop reading it.
    const { container } = render(
      <DatabaseIsolationTable
        isolation={{ databases: [db('platform', false), db('crowdsec', false)], atRisk: [] }}
      />,
    );
    expect(container.querySelector('[data-testid="db-isolation-detail"]')).toBeNull();
  });

  it('renders nothing when the state is unreadable (the card already says so)', () => {
    const { container } = render(<DatabaseIsolationTable isolation={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists only the open databases, with their explicit grantees', () => {
    render(
      <DatabaseIsolationTable
        isolation={{
          databases: [db('platform', true, ['platform']), db('crowdsec', false, ['crowdsec'])],
          atRisk: [],
        }}
      />,
    );
    const panel = screen.getByTestId('db-isolation-detail');
    const rows = panel.querySelectorAll('tbody tr');
    // Exactly one row: the isolated database must not be listed at all.
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('platform');
    expect(panel.textContent).not.toContain('crowdsec');
  });

  it('shows at-risk roles even when no database is open', () => {
    render(
      <DatabaseIsolationTable
        isolation={{
          databases: [db('platform', false)],
          atRisk: [{ datname: 'platform', usename: 'roundcube' }],
        }}
      />,
    );
    expect(screen.getByText(/roundcube → platform/)).toBeTruthy();
  });
});
