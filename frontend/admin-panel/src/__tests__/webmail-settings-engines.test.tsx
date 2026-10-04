/**
 * Roundcube is being retired (ROADMAP R42): Bulwark is listed first as the
 * recommended engine, Roundcube as legacy, and the form falls back to Bulwark —
 * the engine the backend serves when no engine is saved.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const settingsState: { data: unknown } = { data: undefined };

vi.mock('@/hooks/use-webmail-settings', () => ({
  useWebmailSettings: vi.fn(() => ({ data: settingsState.data, isLoading: false, isError: false, error: null })),
  useUpdateWebmailSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock('@/components/MailTaskProgressModal', () => ({ default: () => null }));

const { default: WebmailSettingsTab } = await import('../components/mail-settings/WebmailSettingsTab');

describe('WebmailSettingsTab — engines', () => {
  it('lists Bulwark first as recommended and Roundcube as legacy', () => {
    settingsState.data = { data: { defaultWebmailEngine: 'bulwark', defaultWebmailUrl: 'https://webmail.example.test' } };
    render(<WebmailSettingsTab />);

    const engines = within(screen.getByRole('radiogroup', { name: 'Default webmail engine' })).getAllByRole('radio');
    expect(engines.map((e) => e.getAttribute('data-testid'))).toEqual(['webmail-engine-bulwark', 'webmail-engine-roundcube']);
    expect(screen.getByTestId('webmail-engine-badge-bulwark')).toHaveTextContent('Recommended');
    expect(screen.getByTestId('webmail-engine-badge-roundcube')).toHaveTextContent('Legacy');
    expect(screen.getByTestId('webmail-engine-roundcube')).toHaveTextContent('being retired');
  });

  it('shows Bulwark as active when no engine has been saved', () => {
    settingsState.data = { data: { defaultWebmailUrl: 'https://webmail.example.test' } };
    render(<WebmailSettingsTab />);

    expect(screen.getByTestId('webmail-engine-bulwark')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('webmail-engine-roundcube')).toHaveAttribute('aria-checked', 'false');
  });
});
