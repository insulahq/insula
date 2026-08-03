import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailDriftPage from '../pages/email/EmailDriftPage';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

// Shape per mailDriftItemSchema in @insula/api-contracts. kind='master-user'
// is what renders the "Recreate webmail master" action; resolvedAt=null is what
// makes it ACTIVE.
const DRIFT_ITEM = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'master-user' as const,
  expectedName: 'webmail-master',
  expectedStalwartId: 'stalwart-42',
  platformRowId: 'row-1',
  firstDetectedAt: '2026-08-01T00:00:00Z',
  lastSeenAt: '2026-08-02T00:00:00Z',
  resolvedAt: null,
  resolvedVia: null,
  notes: null,
};

// The page also mounts MailHealthBanner, which reads /admin/mail/health and
// dereferences components.pod — a bare {} makes it throw and every test in the
// file fails for a reason unrelated to what it is testing.
const MOCK_HEALTH = {
  data: {
    healthy: true,
    checkedAt: '2026-08-03T00:00:00Z',
    components: {
      pod: { ready: true, node: 'node-1', phase: 'Running' },
      jmap: { reachable: true },
    },
  },
};

function mockDrift(items: unknown[]) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/mail/health')) return Promise.resolve(MOCK_HEALTH);
    if (path.includes('/mail/drift')) return Promise.resolve({ data: { items, hasActive: items.length > 0 } });
    // Array-shaped by default: sibling cards on this page map/reduce over
    // their lists, and an object fallback makes them throw during render.
    return Promise.resolve({ data: [] });
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailDriftPage />
    </QueryClientProvider>,
  );
}

describe('EmailDriftPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * The amber "What this means" panel described drift as present tense —
   * "found platform DB rows whose Stalwart entries no longer exist" — and was
   * rendered unconditionally, so on a healthy system it sat directly above the
   * green "No active drift detected" panel. Two contradictory statements, with
   * the alarming one first.
   */
  it('hides the drift explainer when there is no active drift', async () => {
    mockDrift([]);
    renderPage();
    expect(await screen.findByText(/No active drift detected/i)).toBeTruthy();
    expect(screen.queryByText(/What this means/i)).toBeNull();
  });

  it('shows the explainer when there IS active drift', async () => {
    mockDrift([DRIFT_ITEM]);
    renderPage();
    expect(await screen.findByText(/What this means/i)).toBeTruthy();
    expect(screen.queryByText(/No active drift detected/i)).toBeNull();
  });

  /**
   * "Recreate webmail master" posts to the same endpoint as Mail Settings'
   * rotate button, and that call always worked. What it did not do was
   * invalidate the drift query, so the row it had just resolved stayed on
   * screen and the button read as broken — while Dismiss and Recreate-empty,
   * which do invalidate, read as working.
   */
  it('refetches the drift list after recreating the webmail master', async () => {
    mockDrift([DRIFT_ITEM]);
    renderPage();

    const btn = await screen.findByTestId('drift-recreate-master-11111111-1111-4111-8111-111111111111');
    const driftCallsBefore = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/mail/drift'),
    ).length;

    fireEvent.click(btn);

    await waitFor(() => {
      const rotated = mockApiFetch.mock.calls.some(
        ([p]) => typeof p === 'string' && p.includes('rotate-webmail-master-password'),
      );
      expect(rotated).toBe(true);
    });

    // The point of the fix: the list is re-read, so the resolved row can leave.
    await waitFor(() => {
      const after = mockApiFetch.mock.calls.filter(
        ([p]) => typeof p === 'string' && p.includes('/mail/drift'),
      ).length;
      expect(after).toBeGreaterThan(driftCallsBefore);
    });
  });

  it('confirms the recreate to the operator instead of appearing to do nothing', async () => {
    mockDrift([DRIFT_ITEM]);
    renderPage();
    fireEvent.click(await screen.findByTestId('drift-recreate-master-11111111-1111-4111-8111-111111111111'));
    expect(await screen.findByTestId('drift-recreate-master-ok-11111111-1111-4111-8111-111111111111')).toBeTruthy();
  });
});
