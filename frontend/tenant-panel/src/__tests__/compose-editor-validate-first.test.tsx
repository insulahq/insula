import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomDeploymentIssue } from '@insula/api-contracts';

// Deploy validates on the server first, and an edit replaces the stack in
// place. It used to delete the stack and create it again, so YAML the server
// refused cost the tenant the stack. The mutations are mocked at their hooks;
// the editor is real (Monaco swapped for a textarea).
const calls: string[] = [];
let validateResult: { ok: boolean; issues: CustomDeploymentIssue[] };
let validateDelayMs = 0;

vi.mock('@/hooks/use-custom-deployments', () => ({
  useValidateCustomDeployment: () => ({
    isPending: false,
    mutateAsync: vi.fn(async () => {
      calls.push('validate');
      if (validateDelayMs) await new Promise((r) => setTimeout(r, validateDelayMs));
      return { data: { ...validateResult, spec: null } };
    }),
  }),
  useReplaceComposeDeployment: () => ({ isPending: false, mutateAsync: vi.fn(async (v: { id: string }) => { calls.push(`replace:${v.id}`); return { data: {} }; }) }),
  useCreateCustomDeployment: () => ({ isPending: false, mutateAsync: vi.fn(async () => { calls.push('create'); return { data: {} }; }) }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({ data: {} })) }));
vi.mock('../components/custom-deployments/MonacoYamlEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="yaml" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const { ComposeEditor } = await import('../components/custom-deployments/ComposeEditor');

const EXISTING = {
  id: 'd1', name: 'collabora', status: 'running', statusMessage: null,
  customSpec: { specVersion: 1, sourceMode: 'compose', services: {}, volumes: {}, configMaps: [], secrets: [], allowRoot: false, autoUpdate: false },
} as never;

const REFUSED: CustomDeploymentIssue = {
  severity: 'error', code: 'COMPOSE_FIELD_REJECTED', path: 'services.collabora.cap_add',
  message: "Compose field 'cap_add' is not supported on this platform.", line: 4,
} as CustomDeploymentIssue;

function renderEditor(mode: 'edit' | 'new' = 'edit') {
  const onCreated = vi.fn();
  render(<ComposeEditor tenantId="t1" existingNames={['collabora']} onClose={vi.fn()} onCreated={onCreated} existingDeployment={mode === 'edit' ? EXISTING : undefined} />);
  return onCreated;
}

beforeEach(() => { calls.length = 0; validateDelayMs = 0; });

describe('Compose editor — Deploy validates first, an edit replaces in place', () => {
  it('★ editing with YAML the server refuses changes nothing and shows the issue', async () => {
    validateResult = { ok: false, issues: [REFUSED] };
    const onCreated = renderEditor();
    const deploy = screen.getByTestId('custom-compose-submit');
    expect(deploy).toBeEnabled();
    fireEvent.click(deploy);
    await waitFor(() => expect(calls).toEqual(['validate']));
    expect(onCreated).not.toHaveBeenCalled();
    expect(await screen.findByText(/'cap_add' is not supported/)).toBeInTheDocument();
  });

  it('★ a clean edit replaces the same stack — no delete, no create', async () => {
    validateResult = { ok: true, issues: [] };
    const onCreated = renderEditor();
    expect(screen.getByTestId('custom-compose-submit')).toHaveTextContent('Update stack');
    fireEvent.click(screen.getByTestId('custom-compose-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls).toEqual(['validate', 'replace:d1']);
  });

  it('a new stack is created after validating', async () => {
    validateResult = { ok: true, issues: [] };
    const onCreated = renderEditor('new');
    fireEvent.change(screen.getByTestId('custom-compose-name'), { target: { value: 'office' } });
    fireEvent.click(screen.getByTestId('custom-compose-submit'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls).toEqual(['validate', 'create']);
  });

  it('a second click while the first Deploy is still validating does nothing', async () => {
    validateResult = { ok: true, issues: [] };
    validateDelayMs = 50;
    const onCreated = renderEditor();
    const deploy = screen.getByTestId('custom-compose-submit');
    fireEvent.click(deploy);
    fireEvent.click(deploy);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['validate', 'replace:d1']);
  });

  it('after a refusal, fixing the YAML re-enables Deploy without pressing Validate', async () => {
    validateResult = { ok: false, issues: [REFUSED] };
    renderEditor();
    fireEvent.click(screen.getByTestId('custom-compose-submit'));
    await screen.findByText(/'cap_add' is not supported/);
    expect(screen.getByTestId('custom-compose-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('yaml'), { target: { value: 'services:\n  web:\n    image: nginx:1.27.5\n' } });
    expect(screen.getByTestId('custom-compose-submit')).toBeEnabled();
  });
});
