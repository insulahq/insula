import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimpleContainerWizard } from '../components/custom-deployments/SimpleContainerWizard';
import { apiFetch } from '@/lib/api-client';

/**
 * Validate sends the private-registry credential, as Deploy does. It used to
 * strip it ("a dry run"), so the server probed the private image anonymously
 * and every validation ended in IMAGE_ACCESS_DENIED with a correct token set.
 */

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  API_BASE: '',
  ApiError: class ApiError extends Error {},
}));
const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockImplementation(((url: string) => Promise.resolve(
    url.includes('/validate')
      ? { data: { ok: true, issues: [], spec: null, rendered: [] } }
      : { data: { cpuModel: 'tiered', cpuTier: 'normal', cpuBurstCores: 6, cpuTierRequest: '5m' } },
  )) as never);
});

function renderWizard(existingDeployment?: unknown) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SimpleContainerWizard
        tenantId="t1"
        existingNames={[]}
        onClose={() => {}}
        onCreated={() => {}}
        existingDeployment={existingDeployment as never}
      />
    </QueryClientProvider>,
  );
}

const validateCall = () => mockApiFetch.mock.calls.find(([url]) => String(url).includes('/validate'));

describe('custom container wizard — Validate', () => {
  it('sends the credential typed into the form', async () => {
    renderWizard();
    fireEvent.change(screen.getByTestId('custom-simple-name'), { target: { value: 'private-app' } });
    fireEvent.change(screen.getByTestId('custom-simple-image'), { target: { value: 'ghcr.io/acme/private:1.0.0' } });
    fireEvent.click(screen.getByTestId('custom-private-registry-toggle'));
    fireEvent.change(screen.getByTestId('custom-private-registry-host'), { target: { value: 'ghcr.io' } });
    fireEvent.change(screen.getByTestId('custom-private-registry-username'), { target: { value: 'bot' } });
    fireEvent.change(screen.getByTestId('custom-private-registry-token'), { target: { value: 'pat-123' } });
    fireEvent.click(screen.getByRole('button', { name: /validate/i }));

    await waitFor(() => expect(validateCall()).toBeDefined());
    const [url, init] = validateCall()!;
    expect(url).toBe('/api/v1/tenants/t1/custom-deployments/validate');
    expect(JSON.parse(String((init as RequestInit).body)).pull_credential).toEqual({ registry_host: 'ghcr.io', username: 'bot', token: 'pat-123' });
  });

  it('names the deployment when an edit is validated, so its stored token is used', async () => {
    renderWizard({
      id: '11111111-2222-4333-8444-555555555555', name: 'private-app', status: 'running',
      customSpec: { sourceMode: 'simple', services: { 'private-app': { image: 'ghcr.io/acme/private:1.0.0', resources: { cpuRequest: '5m', memoryRequest: '128Mi' } } } },
    });
    fireEvent.click(screen.getByRole('button', { name: /validate/i }));
    await waitFor(() => expect(validateCall()).toBeDefined());
    expect(validateCall()![0]).toBe('/api/v1/tenants/t1/custom-deployments/validate?deployment_id=11111111-2222-4333-8444-555555555555');
  });
});
