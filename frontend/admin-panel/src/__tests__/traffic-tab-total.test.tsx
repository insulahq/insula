/**
 * The Traffic tab's combined Total, end to end through the tab: which views
 * offer it, that it starts off, that clicking its row draws it, and that
 * hovering a row highlights that row's line.
 *
 * The hooks are mocked to return a frame per scope — the point here is the
 * tab's decisions, not the fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { TrafficFrame, TrafficSeries } from '@insula/api-contracts';

const times = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 30, i)).toISOString());
const flat = (v: number): number[] => times.map(() => v);

function frameOf(series: TrafficSeries[]): TrafficFrame {
  return {
    from: times[0], to: times[11], stepSeconds: 300, times, unit: 'bytes', resolution: 'fine',
    othersFolded: 0, clamped: false, series,
  };
}

const FRAMES: Record<string, TrafficFrame> = {
  cluster: frameOf([
    { key: 'wire:out', name: 'Outbound (wire)', kind: 'direction', group: 'wire', points: flat(2000) },
    { key: 'n2n:out', name: 'Node-to-node (out)', kind: 'direction', group: 'wire-subset', points: flat(500) },
  ]),
  tenant: frameOf([
    { key: 'out:tenant-a', name: 'Tenant A', kind: 'subject', points: flat(9000) },
    { key: 'out:tenant-b', name: 'Tenant B', kind: 'subject', points: flat(300) },
    { key: 'out:tenant-c', name: 'Tenant C', kind: 'subject', points: flat(40) },
  ]),
  single: frameOf([{ key: 'out:tenant-a', name: 'Tenant A', kind: 'subject', points: flat(9000) }]),
};

let lastParams: { scope?: string; subject?: string; from?: Date; to?: Date } = {};
vi.mock('@/hooks/use-traffic', () => ({
  useTrafficSeries: (params: { scope: string; subject?: string; from: Date; to: Date }) => {
    lastParams = params;
    const key = params.scope === 'tenant' && params.subject ? 'single' : params.scope;
    return { data: FRAMES[key] ?? FRAMES.cluster, isLoading: false, error: null };
  },
  useTrafficSubjects: () => ({
    data: [{ key: 'tenant-a', name: 'Tenant A', value: 1, unit: 'bytes' }],
    isLoading: false,
  }),
}));

const { default: TrafficTab } = await import('@/components/traffic/TrafficTab');

// The tab reads its initial view from the URL, so it renders inside a router.
function render(ui: ReactElement, url = '/monitoring') {
  return rtlRender(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

function chooseScope(label: string): void {
  fireEvent.click(document.getElementById('traffic-scope')!);
  fireEvent.click(screen.getByRole('option', { name: label }));
}

const table = (): HTMLElement => screen.getByTestId('traffic-summary');
const totalRow = (): HTMLElement | null => table().querySelector('tr[data-series="__total"]');
const totalLine = (): Element | null => document.querySelector('svg [data-series="__total"]');

describe('Traffic tab — the combined Total', () => {
  beforeEach(() => { lastParams = {}; });

  it('is not offered on the cluster view, whose rows are the wire and subsets of it', () => {
    render(<TrafficTab />);
    expect(lastParams.scope).toBe('cluster');
    expect(totalRow()).toBeNull();
    expect(totalLine()).toBeNull();
  });

  it('is offered on a tenant breakdown, off until clicked', () => {
    render(<TrafficTab />);
    chooseScope('Tenant');
    const row = totalRow();
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Total')).toBeInTheDocument();
    expect(row!.getAttribute('aria-pressed')).toBe('false');
    expect(totalLine()).toBeNull();

    fireEvent.click(row!);
    expect(totalRow()!.getAttribute('aria-pressed')).toBe('true');
    expect(totalLine()).not.toBeNull();
  });

  it('paints the highest-traffic tenant on top of the others, and the Total over all of them', () => {
    render(<TrafficTab />);
    chooseScope('Tenant');
    fireEvent.click(totalRow()!);
    const order = [...document.querySelectorAll('svg [data-series]')].map((g) => g.getAttribute('data-series'));
    expect(order).toEqual(['out:tenant-c', 'out:tenant-b', 'out:tenant-a', '__total']);
  });

  it('greys out while fewer than two rows are shown, and ignores clicks then', () => {
    render(<TrafficTab />);
    chooseScope('Tenant');
    fireEvent.click(totalRow()!);
    fireEvent.click(table().querySelector('tr[data-series="out:tenant-b"]')!);
    fireEvent.click(table().querySelector('tr[data-series="out:tenant-c"]')!);
    expect(totalRow()!.getAttribute('aria-disabled')).toBe('true');
    expect(totalLine()).toBeNull();
    fireEvent.click(totalRow()!);
    expect(totalLine()).toBeNull();
  });

  it('is not offered when a single tenant is chosen: it would be that tenant again', () => {
    render(<TrafficTab />);
    chooseScope('Tenant');
    fireEvent.click(document.getElementById('traffic-subject')!);
    fireEvent.click(screen.getByRole('option', { name: /Tenant A/ }));
    expect(totalRow()).toBeNull();
  });

  it('highlights the hovered row’s line and fades the rest', () => {
    render(<TrafficTab />);
    chooseScope('Tenant');
    fireEvent.mouseEnter(table().querySelector('tr[data-series="out:tenant-b"]')!);
    const dimOf = (key: string): string | null => document.querySelector(`svg [data-series="${key}"]`)!.getAttribute('data-dim');
    expect(dimOf('out:tenant-b')).toBe('false');
    expect(dimOf('out:tenant-a')).toBe('true');
    fireEvent.mouseLeave(table().querySelector('tr[data-series="out:tenant-b"]')!);
    expect(dimOf('out:tenant-a')).toBe('false');
  });

  it('shows both pills at the same size', () => {
    render(<TrafficTab />);
    const tz = screen.getByTestId('traffic-tzpill');
    const steps = screen.getByTestId('traffic-steps-pill');
    expect(steps.className).toBe(tz.className);
  });
});

describe('Traffic tab — initial view from the URL', () => {
  beforeEach(() => { lastParams = {}; });

  it('opens on a tenant and 7 days when linked with ?scope=tenant&subject=…&range=7d', () => {
    render(<TrafficTab />, '/monitoring?scope=tenant&subject=tenant-a&range=7d');
    expect(lastParams.scope).toBe('tenant');
    expect(lastParams.subject).toBe('tenant-a');
    const hours = (lastParams.to!.getTime() - lastParams.from!.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24 * 7, 5);
    // The pickers show the linked choice, not the defaults.
    expect(document.getElementById('traffic-subject')!.textContent).toContain('Tenant A');
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();
  });

  it('shows a linked tenant as chosen even when it moved nothing (not in the ranked list)', () => {
    render(<TrafficTab />, '/monitoring?scope=tenant&subject=tenant-quiet-1a2b3c4d&range=7d');
    expect(lastParams.subject).toBe('tenant-quiet-1a2b3c4d');
    const picker = document.getElementById('traffic-subject')!;
    expect(picker.textContent).toContain('tenant-quiet-1a2b3c4d');
    expect(picker.textContent).not.toContain('All tenants');
  });

  it('falls back to the default view for unknown values', () => {
    render(<TrafficTab />, '/monitoring?scope=bogus&range=nope&subject=x');
    expect(lastParams.scope).toBe('cluster');
    expect(lastParams.subject).toBeUndefined();
    const hours = (lastParams.to!.getTime() - lastParams.from!.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 5);
  });
});
