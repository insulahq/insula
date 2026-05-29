import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ProvidersTable from './ProvidersTable';
import type { NotificationProviderResponse } from '@k8s-hosting/api-contracts';

const listMock = vi.fn();
const createMutate = vi.fn().mockResolvedValue({ data: {} });
const updateMutate = vi.fn().mockResolvedValue({ data: {} });
const deleteMutate = vi.fn().mockResolvedValue(undefined);
const testMutate = vi.fn().mockResolvedValue({ data: { status: 'success', testedAt: '2026-05-28T00:00:00Z', error: null } });

vi.mock('@/hooks/use-notification-providers', () => ({
  useNotificationProviders: () => listMock(),
  useCreateNotificationProvider: () => ({ mutateAsync: createMutate, isPending: false, error: null }),
  useUpdateNotificationProvider: () => ({ mutateAsync: updateMutate, isPending: false, error: null }),
  useDeleteNotificationProvider: () => ({ mutateAsync: deleteMutate, isPending: false, error: null }),
  useTestNotificationProvider: () => ({ mutateAsync: testMutate, isPending: false, error: null, data: { data: { status: 'success', testedAt: '2026-05-28T00:00:00Z', error: null } } }),
}));

function provider(overrides: Partial<NotificationProviderResponse> = {}): NotificationProviderResponse {
  return {
    id: 'p1',
    name: 'Brevo EU',
    providerType: 'brevo',
    scope: 'platform',
    tenantId: null,
    channel: 'email',
    isDefault: true,
    enabled: true,
    smtpHost: 'smtp-relay.brevo.com',
    smtpPort: 587,
    smtpSecure: false,
    authUsername: 'apikey',
    authPasswordSet: true,
    fromAddress: 'noreply@example.test',
    fromName: 'Phoenix',
    region: 'eu',
    lastTestedAt: '2026-05-28T10:00:00.000Z',
    lastTestStatus: 'success',
    lastTestError: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    createdByUserId: 'admin',
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockReturnValue({
    data: { data: [provider()] },
    isLoading: false,
    error: null,
  });
});

describe('ProvidersTable', () => {
  it('renders one row per provider', () => {
    render(<ProvidersTable />, { wrapper: createWrapper() });
    expect(screen.getByTestId('provider-row-p1')).toBeInTheDocument();
    expect(screen.getByText('Brevo EU')).toBeInTheDocument();
  });

  it('renders empty state when no providers configured', () => {
    listMock.mockReturnValue({ data: { data: [] }, isLoading: false, error: null });
    render(<ProvidersTable />, { wrapper: createWrapper() });
    expect(screen.getByText(/No providers configured yet/)).toBeInTheDocument();
  });

  it('shows the default badge for the default provider', () => {
    render(<ProvidersTable />, { wrapper: createWrapper() });
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('disables delete on the default provider', () => {
    render(<ProvidersTable />, { wrapper: createWrapper() });
    const btn = screen.getByTestId('provider-delete-p1') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('opens the create drawer when "Add provider" is clicked', async () => {
    const user = userEvent.setup();
    render(<ProvidersTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('provider-create'));
    expect(screen.getByTestId('provider-edit-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('provider-type')).toBeInTheDocument();
  });

  it('create form: changing provider type swaps suggested SMTP host', async () => {
    const user = userEvent.setup();
    render(<ProvidersTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('provider-create'));
    const host = screen.getByTestId('provider-smtp-host') as HTMLInputElement;
    expect(host.value).toBe('');
    await user.selectOptions(screen.getByTestId('provider-type'), 'postmark');
    expect(host.value).toBe('smtp.postmarkapp.com');
  });

  it('save creates a new provider with the right payload', async () => {
    const user = userEvent.setup();
    render(<ProvidersTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('provider-create'));
    await user.type(screen.getByTestId('provider-name'), 'Test');
    await user.type(screen.getByTestId('provider-smtp-host'), 'smtp.example.test');
    await user.type(screen.getByTestId('provider-from-address'), 'ops@example.test');
    await user.click(screen.getByTestId('provider-save'));
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const call = createMutate.mock.calls[0][0] as { name: string; fromAddress: string };
    expect(call.name).toBe('Test');
    expect(call.fromAddress).toBe('ops@example.test');
  });

  it('opens test dialog and submits with operator-supplied recipient', async () => {
    const user = userEvent.setup();
    render(<ProvidersTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('provider-test-p1'));
    expect(screen.getByTestId('provider-test-dialog')).toBeInTheDocument();
    await user.type(screen.getByTestId('provider-test-recipient'), 'ops@example.test');
    await user.click(screen.getByTestId('provider-test-submit'));
    await waitFor(() => expect(testMutate).toHaveBeenCalledTimes(1));
    expect(testMutate.mock.calls[0][0]).toEqual({ id: 'p1', input: { recipientEmail: 'ops@example.test' } });
  });
});
