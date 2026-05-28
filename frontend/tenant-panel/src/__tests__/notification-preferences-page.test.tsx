import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NotificationPreferences from '../pages/NotificationPreferences';

const updatePreferencesMutate = vi.fn();
const updateSettingsMutate = vi.fn();

vi.mock('../hooks/use-notifications', () => ({
  useNotificationPreferences: () => ({
    data: {
      data: {
        preferences: [
          { categoryId: 'tenant.suspended', channel: 'in_app', enabled: true, isMandatory: true },
          { categoryId: 'tenant.suspended', channel: 'email', enabled: true, isMandatory: true },
          { categoryId: 'tasks.scheduled_failure', channel: 'in_app', enabled: true, isMandatory: false },
          { categoryId: 'tasks.scheduled_failure', channel: 'email', enabled: false, isMandatory: false },
        ],
      },
    },
    isLoading: false,
    error: null,
  }),
  useUpdateNotificationPreferences: () => ({
    mutateAsync: updatePreferencesMutate,
    isPending: false,
    error: null,
  }),
  useNotificationSettings: () => ({
    data: {
      data: {
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: null,
        digestMode: 'immediate',
        locale: 'en',
      },
    },
    isLoading: false,
    error: null,
  }),
  useUpdateNotificationSettings: () => ({
    mutateAsync: updateSettingsMutate,
    isPending: false,
    error: null,
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationPreferences />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationPreferences page', () => {
  beforeEach(() => {
    updatePreferencesMutate.mockReset();
    updateSettingsMutate.mockReset();
  });

  it('renders all four channel rows for the two seeded categories', () => {
    renderPage();
    expect(screen.getByTestId('notification-prefs-heading')).toBeInTheDocument();
    expect(screen.getByTestId('pref-tenant.suspended-in_app')).toBeInTheDocument();
    expect(screen.getByTestId('pref-tenant.suspended-email')).toBeInTheDocument();
    expect(screen.getByTestId('pref-tasks.scheduled_failure-in_app')).toBeInTheDocument();
    expect(screen.getByTestId('pref-tasks.scheduled_failure-email')).toBeInTheDocument();
  });

  it('locks mandatory categories so the checkbox cannot be toggled', () => {
    renderPage();
    const inAppCheckbox = screen.getByTestId('pref-tenant.suspended-in_app') as HTMLInputElement;
    expect(inAppCheckbox.disabled).toBe(true);
    expect(screen.getByTestId('mandatory-tenant.suspended')).toBeInTheDocument();
  });

  it('queues a preference change and submits via the bulk mutation', async () => {
    renderPage();
    const emailCheckbox = screen.getByTestId('pref-tasks.scheduled_failure-email') as HTMLInputElement;
    expect(emailCheckbox.checked).toBe(false);
    fireEvent.click(emailCheckbox);
    const saveButton = screen.getByTestId('save-preferences');
    fireEvent.click(saveButton);
    await waitFor(() => expect(updatePreferencesMutate).toHaveBeenCalledTimes(1));
    expect(updatePreferencesMutate).toHaveBeenCalledWith({
      updates: [{ categoryId: 'tasks.scheduled_failure', channel: 'email', enabled: true }],
    });
  });

  it('persists settings changes', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('quiet-start'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByTestId('quiet-end'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByTestId('digest-mode'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByTestId('timezone'), { target: { value: 'Europe/Berlin' } });
    fireEvent.click(screen.getByTestId('save-settings'));
    await waitFor(() => expect(updateSettingsMutate).toHaveBeenCalledTimes(1));
    expect(updateSettingsMutate).toHaveBeenCalledWith({
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      digestMode: 'daily',
      timezone: 'Europe/Berlin',
    });
  });

  it('disables the save button when there are no queued preference changes', () => {
    renderPage();
    const saveButton = screen.getByTestId('save-preferences') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });
});
