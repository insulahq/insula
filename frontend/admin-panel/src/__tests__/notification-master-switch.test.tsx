/**
 * The lever the operator did not have, when stopping a
 * notification storm meant editing `notification_categories` over psql.
 *
 * The disable path is asserted as TWO clicks on purpose: this switch silences
 * security, backup and certificate alerts too, so a single stray click must
 * not be able to do it.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MasterSwitchCard from '../features/notifications/MasterSwitchCard';

const mutate = vi.fn();
let settings: { notificationsEnabled: boolean } = { notificationsEnabled: true };
let mutationState: { isPending: boolean; isError: boolean } = { isPending: false, isError: false };

vi.mock('../hooks/use-system-settings', () => ({
  useSystemSettings: () => ({ data: { data: settings }, isLoading: false }),
  useUpdateSystemSettings: () => ({ mutate, ...mutationState }),
}));

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MasterSwitchCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mutate.mockReset();
  settings = { notificationsEnabled: true };
  mutationState = { isPending: false, isError: false };
});

describe('notification master switch', () => {
  it('needs two clicks to silence everything', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('disable-notifications'));
    // First click only arms it — nothing has been sent yet.
    expect(mutate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm-disable-notifications'));
    expect(mutate).toHaveBeenCalledWith({ notificationsEnabled: false });
  });

  it('can be armed and then cancelled without sending anything', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('disable-notifications'));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('disable-notifications')).toBeInTheDocument();
  });

  it('says plainly that nobody is being told anything while it is off', () => {
    settings = { notificationsEnabled: false };
    renderCard();

    expect(screen.getByText(/nobody is being told anything/i)).toBeInTheDocument();
    // And names what is being suppressed, so "off" is not read as "quieter".
    expect(screen.getByText(/security, backup and certificate alerts/i)).toBeInTheDocument();
  });

  it('re-enables in one click — turning it back ON is not the dangerous direction', async () => {
    const user = userEvent.setup();
    settings = { notificationsEnabled: false };
    renderCard();

    await user.click(screen.getByTestId('enable-notifications'));
    expect(mutate).toHaveBeenCalledWith({ notificationsEnabled: true });
  });

  it('surfaces a failed toggle as an operator error instead of silently reverting', () => {
    mutationState = { isPending: false, isError: true };
    renderCard();

    expect(screen.getByTestId('master-switch-error')).toBeInTheDocument();
  });
});
