import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ProviderCoverageBanner from './ProviderCoverageBanner';
import type {
  NotificationProviderResponse,
  NotificationCategoryResponse,
  NotificationChannelId,
} from '@insula/api-contracts';

const providersMock = vi.fn();
const categoriesMock = vi.fn();

vi.mock('@/hooks/use-notification-providers', () => ({
  useNotificationProviders: () => providersMock(),
}));
vi.mock('@/hooks/use-notification-categories', () => ({
  useNotificationCategories: () => categoriesMock(),
}));

function provider(overrides: Partial<NotificationProviderResponse> = {}): NotificationProviderResponse {
  return {
    id: 'p1',
    name: 'Provider',
    providerType: 'brevo',
    scope: 'platform',
    tenantId: null,
    channel: 'email',
    isDefault: true,
    enabled: true,
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
    smtpSecure: false,
    authUsername: 'apikey',
    authPasswordSet: true,
    fromAddress: 'noreply@example.test',
    fromName: 'Insula',
    region: null,
    ntfyServerUrl: null,
    ntfyTopic: null,
    ntfyAuthMethod: null,
    ntfyTokenSet: false,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as NotificationProviderResponse;
}

function category(channels: NotificationChannelId[]): NotificationCategoryResponse {
  return {
    id: 'admin.slo_alert_critical',
    displayName: 'SLO alert firing (critical)',
    description: 'x',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: channels,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  } as NotificationCategoryResponse;
}

const ok = <T,>(data: T) => ({ data: { data }, isError: false });

beforeEach(() => {
  providersMock.mockReset();
  categoriesMock.mockReset();
});

describe('ProviderCoverageBanner', () => {
  it('warns for a channel routed to by categories with no provider at all', () => {
    providersMock.mockReturnValue(ok([]));
    categoriesMock.mockReturnValue(ok([category(['in_app', 'email', 'ntfy'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.getByTestId('provider-coverage-banner')).toBeInTheDocument();
    expect(screen.getByText(/2 channels cannot deliver/)).toBeInTheDocument();
    expect(screen.getAllByText(/no_default_notification_provider/)).toHaveLength(2);
  });

  it('stays silent when every routed channel has a usable default provider', () => {
    providersMock.mockReturnValue(ok([
      provider({ id: 'e', channel: 'email' }),
      provider({ id: 'n', channel: 'ntfy', providerType: 'ntfy' }),
    ]));
    categoriesMock.mockReturnValue(ok([category(['in_app', 'email', 'ntfy'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.queryByTestId('provider-coverage-banner')).not.toBeInTheDocument();
  });

  it('does NOT count a provider that exists but is disabled or not default', () => {
    // The failure this banner exists for: `notification_providers` is not
    // empty, so the Providers tab looks populated, yet the dispatcher's
    // lookup (platform scope + is_default + enabled) still finds nothing.
    providersMock.mockReturnValue(ok([
      provider({ id: 'e1', channel: 'email', enabled: false }),
      provider({ id: 'e2', channel: 'email', isDefault: false }),
      provider({ id: 'e3', channel: 'email', scope: 'tenant', tenantId: 't1' }),
      provider({ id: 'n', channel: 'ntfy', providerType: 'ntfy' }),
    ]));
    categoriesMock.mockReturnValue(ok([category(['email', 'ntfy'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.getByText(/One channel cannot deliver/)).toBeInTheDocument();
    expect(screen.getByText(/Email/)).toBeInTheDocument();
  });

  it('ignores in_app, which needs no transport', () => {
    providersMock.mockReturnValue(ok([]));
    categoriesMock.mockReturnValue(ok([category(['in_app'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.queryByTestId('provider-coverage-banner')).not.toBeInTheDocument();
  });

  it('says nothing about a channel no category routes to', () => {
    providersMock.mockReturnValue(ok([]));
    categoriesMock.mockReturnValue(ok([category(['in_app', 'email'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.getByText(/One channel cannot deliver/)).toBeInTheDocument();
    expect(screen.queryByText(/ntfy push/)).not.toBeInTheDocument();
  });

  it('renders nothing when a query failed rather than inventing coverage', () => {
    providersMock.mockReturnValue({ data: undefined, isError: true });
    categoriesMock.mockReturnValue(ok([category(['email'])]));
    render(<ProviderCoverageBanner />);
    expect(screen.queryByTestId('provider-coverage-banner')).not.toBeInTheDocument();
  });
});
