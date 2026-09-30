/**
 * The tenant Traffic tab's combined Total: offered on a breakdown of the
 * tenant's routes or applications, never on the account view (one subject's
 * two directions), and off until clicked. The hooks are mocked per scope.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrafficFrame, TrafficSeries } from '@insula/api-contracts';

const times = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 30, i)).toISOString());
const flat = (v: number): number[] => times.map(() => v);
const frameOf = (series: TrafficSeries[]): TrafficFrame => ({
  from: times[0], to: times[11], stepSeconds: 300, times, unit: 'bytes', resolution: 'fine',
  othersFolded: 0, clamped: false, series,
});

const FRAMES: Record<string, TrafficFrame> = {
  tenant: frameOf([
    { key: 'out', name: 'Outbound', kind: 'direction', points: flat(900) },
    { key: 'in', name: 'Inbound', kind: 'direction', points: flat(100) },
  ]),
  route: frameOf([
    { key: 'out:svc-a', name: 'www.example.test → website', kind: 'subject', points: flat(900) },
    { key: 'out:svc-b', name: 'shop.example.test → shop', kind: 'subject', points: flat(50) },
  ]),
};

vi.mock('@/hooks/use-tenant-context', () => ({ useTenantContext: () => ({ tenantId: 't1' }) }));
vi.mock('@/hooks/use-bandwidth', () => ({ useBandwidth: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-traffic', () => ({
  useTrafficSeries: (_id: string, params: { scope: string }) => ({
    data: FRAMES[params.scope] ?? FRAMES.tenant, isLoading: false, error: null,
  }),
  useTrafficSubjects: () => ({ data: [], isLoading: false }),
}));

const { default: TenantTrafficTab } = await import('@/components/traffic/TenantTrafficTab');

const totalRow = (): Element | null => document.querySelector('[data-testid="traffic-summary"] tr[data-series="__total"]');

describe('Tenant Traffic tab — the combined Total', () => {
  it('is not offered on the account view', () => {
    render(<TenantTrafficTab />);
    expect(totalRow()).toBeNull();
  });

  it('is offered on the routes breakdown, off until clicked, then drawn over the rest', () => {
    render(<TenantTrafficTab />);
    fireEvent.click(document.getElementById('tenant-traffic-scope')!);
    fireEvent.click(screen.getByRole('option', { name: 'My routes' }));
    expect(totalRow()!.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('svg [data-series="__total"]')).toBeNull();
    fireEvent.click(totalRow()!);
    const order = [...document.querySelectorAll('svg [data-series]')].map((g) => g.getAttribute('data-series'));
    expect(order).toEqual(['out:svc-b', 'out:svc-a', '__total']);
  });
});
