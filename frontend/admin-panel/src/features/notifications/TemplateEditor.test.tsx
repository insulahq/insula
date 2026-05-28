/**
 * TemplateEditor unit tests — Platform → Notifications → Templates.
 *
 * Mocks the four mutation hooks so we can exercise:
 *   - Variables panel renders
 *   - Preview button calls the preview mutation
 *   - Restore-stock requires an inline confirm (no window.confirm)
 *   - Save is disabled when there are no changes
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TemplateEditor from './TemplateEditor';

const detailMock = vi.fn();
const updateMutate = vi.fn();
const previewMutate = vi.fn();
const restoreMutate = vi.fn();

vi.mock('@/hooks/use-notification-templates', () => ({
  useNotificationTemplate: (id: string | null) => detailMock(id),
  useUpdateNotificationTemplate: () => ({
    mutateAsync: updateMutate,
    isPending: false,
    error: null,
  }),
  usePreviewNotificationTemplate: () => ({
    mutateAsync: previewMutate,
    isPending: false,
    error: null,
  }),
  useRestoreNotificationTemplate: () => ({
    mutateAsync: restoreMutate,
    isPending: false,
    error: null,
  }),
}));

const SEED_TEMPLATE = {
  id: 't-backup-failed-email-en',
  categoryId: 'backup.failed',
  channel: 'email' as const,
  locale: 'en',
  subjectTemplate: 'Backup failed for {{tenantName}}',
  bodyTemplate: '<mjml><mj-body>{{message}}</mj-body></mjml>',
  bodyFormat: 'mjml' as const,
  variablesSchema: [
    { name: 'tenantName', type: 'string' as const, required: true },
    { name: 'message', type: 'string' as const },
  ],
  isActive: true,
  isSeed: true,
  version: 1,
  editedByUserId: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  detailMock.mockReturnValue({
    data: { data: SEED_TEMPLATE },
    isLoading: false,
    error: null,
  });
  updateMutate.mockResolvedValue({ data: SEED_TEMPLATE });
  previewMutate.mockResolvedValue({
    data: {
      subject: 'Backup failed for Acme',
      body: '<html><body>boom</body></html>',
      bodyFormat: 'html',
    },
  });
  restoreMutate.mockResolvedValue({ data: SEED_TEMPLATE });
});

describe('TemplateEditor', () => {
  it('renders the editor with subject + body', () => {
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByTestId('template-editor')).toBeInTheDocument();
    expect(screen.getByTestId('template-subject')).toHaveValue(SEED_TEMPLATE.subjectTemplate);
    expect(screen.getByTestId('template-body')).toHaveValue(SEED_TEMPLATE.bodyTemplate);
  });

  it('renders the variables panel', () => {
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByText(/tenantName:/)).toBeInTheDocument();
    expect(screen.getByText(/message:/)).toBeInTheDocument();
  });

  it('preview button calls the preview mutation and renders result', async () => {
    const user = userEvent.setup();
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('preview-button'));
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('preview-output')).toBeInTheDocument());
    expect(screen.getByText('Backup failed for Acme')).toBeInTheDocument();
  });

  it('restore-seed requires inline confirmation', async () => {
    const user = userEvent.setup();
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('restore-seed-button'));
    expect(screen.getByTestId('restore-confirm')).toBeInTheDocument();
    expect(restoreMutate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('restore-confirm-yes'));
    await waitFor(() => expect(restoreMutate).toHaveBeenCalledWith(SEED_TEMPLATE.id));
  });

  it('save is disabled when there are no changes', () => {
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByTestId('template-save')).toBeDisabled();
  });

  it('save is enabled after body changes and calls the update mutation', async () => {
    const user = userEvent.setup();
    render(<TemplateEditor templateId={SEED_TEMPLATE.id} onClose={vi.fn()} />, { wrapper: createWrapper() });
    const body = screen.getByTestId('template-body');
    await user.clear(body);
    await user.type(body, 'updated');
    expect(screen.getByTestId('template-save')).toBeEnabled();
    await user.click(screen.getByTestId('template-save'));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const call = updateMutate.mock.calls[0][0] as { id: string; input: { bodyTemplate: string } };
    expect(call.id).toBe(SEED_TEMPLATE.id);
    expect(call.input.bodyTemplate).toBe('updated');
  });
});
