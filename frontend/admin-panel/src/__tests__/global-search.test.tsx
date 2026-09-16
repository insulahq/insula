import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import GlobalSearch from '@/components/search/GlobalSearch';

/**
 * The header search box.
 *
 * Two behaviours here are not cosmetic:
 *
 *   - the <input> must not be in the DOM until first focus. That is the
 *     entire reason this control was previously removed: an always-present
 *     input on an origin with a saved login made password managers offer to
 *     autofill on every page load.
 *   - a failed RECORD query must still render the PAGE hits, and must say so.
 *     Rendering "No results" when the API is down turns an outage into
 *     "your estate is empty", which is the failure mode this codebase keeps
 *     re-learning.
 */

const mockFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockFetch(...args),
  ApiError: class extends Error {},
}));

const mockUser = { role: 'super_admin' as string | undefined };
vi.mock('@/hooks/use-auth', () => ({
  useAuth: (selector: (s: { user: { role: string | undefined } }) => unknown) =>
    selector({ user: { role: mockUser.role } }),
}));

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const okResponse = (groups: unknown[]) => ({ data: { groups } });

const TENANT_GROUP = {
  type: 'tenant',
  label: 'Tenants',
  truncated: false,
  items: [
    { id: 't1', type: 'tenant', title: 'Acme Ltd', subtitle: null, href: '/tenants/t1', badge: 'active' },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(okResponse([]));
  mockUser.role = 'super_admin';
});

afterEach(() => {
  vi.useRealTimers();
});

/** Type into the box, then flush the 250 ms debounce. */
async function typeQuery(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByTestId('global-search-trigger'));
  const input = await screen.findByTestId('global-search-input');
  await user.type(input, text);
  await act(async () => { vi.advanceTimersByTime(300); });
  return input;
}

describe('deferred input mount', () => {
  it('renders no <input> before the box is touched', () => {
    renderSearch();
    // The whole point: a password manager scanning the DOM at page load
    // finds nothing to offer to fill.
    expect(screen.queryByTestId('global-search-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('global-search-trigger')).toBeInTheDocument();
  });

  it('mounts and focuses the input on click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await user.click(screen.getByTestId('global-search-trigger'));
    const input = await screen.findByTestId('global-search-input');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('carries the anti-autofill attributes once mounted', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await user.click(screen.getByTestId('global-search-trigger'));
    const input = await screen.findByTestId('global-search-input');
    expect(input).toHaveAttribute('type', 'search');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    // A <form> ancestor is itself a manager trigger.
    expect(input.closest('form')).toBeNull();
  });
});

describe('results', () => {
  it('shows page hits immediately, before any record response', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Never resolves — records are still in flight.
    mockFetch.mockImplementation(() => new Promise(() => {}));
    renderSearch();
    await typeQuery(user, 'waf');
    expect(await screen.findByText('WAF Events')).toBeInTheDocument();
  });

  it('merges record groups under their own headings', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch.mockResolvedValue(okResponse([TENANT_GROUP]));
    renderSearch();
    await typeQuery(user, 'acme');
    expect(await screen.findByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('keeps page hits and explains itself when the record query fails', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch.mockRejectedValue(new Error('500'));
    renderSearch();
    await typeQuery(user, 'waf');
    expect(await screen.findByTestId('global-search-records-error')).toBeInTheDocument();
    // The page hit survives the record failure.
    expect(screen.getByText('WAF Events')).toBeInTheDocument();
    // And it must NOT claim there is nothing to find.
    expect(screen.queryByTestId('global-search-empty')).not.toBeInTheDocument();
  });

  it('says "no matches" only when the query genuinely returned nothing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch.mockResolvedValue(okResponse([]));
    renderSearch();
    await typeQuery(user, 'zzzzqqq');
    expect(await screen.findByTestId('global-search-empty')).toBeInTheDocument();
  });

  it('does not call the API for a one-character query', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, 'a');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still shows page hits for a one-character query', async () => {
    // Local matching costs an array scan, so there is no reason to withhold
    // it below the API minimum — only the RECORD half needs two characters.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, 'p');
    expect((await screen.findAllByTestId('global-search-row')).length).toBeGreaterThan(0);
  });

  it('prompts for more characters when nothing matches locally either', async () => {
    // "7" appears nowhere in the registry, so there are no local hits AND the
    // term is too short to query records — the one case where the hint is the
    // honest thing to say.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, '7');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('global-search-too-short')).toBeInTheDocument();
  });

  it('sends one request per typing burst, not one per character', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, 'tenant');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('url-encodes the term so a query with & or # is not truncated', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, 'a&b');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('q=a%26b'),
      expect.anything(),
    );
  });

  it('filters page hits by the caller role', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockUser.role = 'support';
    renderSearch();
    await typeQuery(user, 'waf');
    // WAF Events is super_admin-only in App.tsx, so search must not offer it.
    await waitFor(() => expect(screen.queryByText('WAF Events')).not.toBeInTheDocument());
  });
});

describe('keyboard', () => {
  it('moves the highlight with arrow keys and wraps at the ends', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    await typeQuery(user, 'backup');

    const rows = await screen.findAllByTestId('global-search-row');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByTestId('global-search-row')[1]).toHaveAttribute('aria-selected', 'true');

    // Up from the second lands back on the first; up again wraps to the last.
    await user.keyboard('{ArrowUp}{ArrowUp}');
    const after = screen.getAllByTestId('global-search-row');
    expect(after[after.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('clears on the first Escape and closes on the second', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    const input = await typeQuery(user, 'waf');

    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    // Closing on the first press would throw away what was typed when the
    // user only meant to start the query again.
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('global-search-results')).not.toBeInTheDocument();
  });

  it('exposes the active row through aria-activedescendant', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    const input = await typeQuery(user, 'backup');
    await screen.findAllByTestId('global-search-row');
    expect(input).toHaveAttribute('aria-activedescendant', 'gs-row-0');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'gs-row-1');
  });

  it('marks itself as a combobox that is expanded only while showing results', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch();
    const input = await typeQuery(user, 'waf');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.clear(input);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});
