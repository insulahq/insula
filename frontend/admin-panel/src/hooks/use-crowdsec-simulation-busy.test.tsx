/**
 * Writes to the agent's simulation config run one at a time in the panel.
 *
 * The backend compare-and-swaps them, but two quick clicks on different
 * scenarios were also reachable from ONE tab (only the clicked row was
 * disabled). Both mutations share a mutation key so `useSimulationConfigBusy`
 * sees either of them — the table and the Enable/Disable button lock on it.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pending: Array<(v: unknown) => void> = [];
const apiFetch = vi.fn(() => new Promise((resolve) => { pending.push(resolve); }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...(a as [])) }));

import { useSetScenarioSimulation, useSetTrafficDetection, useSimulationConfigBusy } from './use-crowdsec';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => ({
    scenario: useSetScenarioSimulation(),
    detection: useSetTrafficDetection(),
    busy: useSimulationConfigBusy(),
  }), { wrapper });
}

beforeEach(() => { pending.length = 0; apiFetch.mockClear(); });

describe('useSimulationConfigBusy', () => {
  it('is busy while a scenario toggle is in flight, and clears when it settles', async () => {
    const { result } = setup();
    expect(result.current.busy).toBe(false);

    act(() => { result.current.scenario.mutate({ name: 'crowdsecurity/http-probing', simulated: true }); });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => { pending[0]({ data: { simulated: [], rolledPods: 0, rollError: null } }); });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it('is busy while the Enable/Disable write is in flight', async () => {
    const { result } = setup();
    act(() => { result.current.detection.mutate({ enabled: false }); });
    await waitFor(() => expect(result.current.busy).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/admin/security/crowdsec/traffic-detection',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    );
    await act(async () => { pending[0]({ data: { enabled: false, alertOnly: [], rolledPods: 0, rollError: null } }); });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });
});
