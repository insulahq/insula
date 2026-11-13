/**
 * "Confirm it is you" — the step-up a gated action asks for, and the hook
 * that asks then repeats the refused request.
 *
 * NOTE: the same test exists in tenant-panel (same dialog, same hook).
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiFetch, startAuthentication } = vi.hoisted(() => ({ apiFetch: vi.fn(), startAuthentication: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => ({ ...(await orig<typeof import('@/lib/api-client')>()), apiFetch }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }));

const { ApiError } = await import('@/lib/api-client');
const { default: StepUpDialog } = await import('@/components/StepUpDialog');
const { useStepUpGate } = await import('@/hooks/use-step-up-gate');

const refusal = (over: Record<string, unknown> = {}) => ({
  methods: ['password', 'passkey'] as const, maxAgeSeconds: 300, impersonation: false, credentialEmail: null, ...over,
});
const stepUpRequired = (details: Record<string, unknown> = {}) =>
  new ApiError(403, 'STEP_UP_REQUIRED', 'Confirm it is you', { methods: ['password'], maxAgeSeconds: 300, ...details });

beforeEach(() => { vi.resetAllMocks(); });

describe('StepUpDialog', () => {
  it('says how long it unlocks, for this browser session only', () => {
    render(<StepUpDialog what="the key" refusal={refusal()} onVerified={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('step-up-explainer').textContent).toMatch(/5 minutes, in this browser session only/);
    expect(screen.queryByTestId('step-up-impersonation')).toBeNull();
  });

  it('a wrong password keeps the dialog open and lets the person try again', async () => {
    apiFetch
      .mockRejectedValueOnce(new ApiError(401, 'STEP_UP_FAILED', 'Step-up authentication failed'))
      .mockResolvedValueOnce({ data: { ok: true } });
    const onVerified = vi.fn();
    render(<StepUpDialog what="the key" refusal={refusal()} onVerified={onVerified} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    expect(await screen.findByTestId('step-up-error')).toHaveTextContent('That did not match');
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/me/step-up/password', expect.objectContaining({ body: JSON.stringify({ password: 'right' }) }));
  });

  it('a closed passkey prompt is said as such, and verifies nothing', async () => {
    apiFetch.mockResolvedValueOnce({ data: { challenge: 'c' } });
    startAuthentication.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    const onVerified = vi.fn();
    render(<StepUpDialog what="the key" refusal={refusal()} onVerified={onVerified} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('step-up-passkey'));
    expect(await screen.findByTestId('step-up-error')).toHaveTextContent('closed or timed out');
    expect(onVerified).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1); // options only, never verify
  });

  it('cancels with the close button and with Escape', () => {
    const onCancel = vi.fn();
    render(<StepUpDialog what="the key" refusal={refusal()} onVerified={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('under "Login as tenant" asks for the staff member\'s own credential, by name', () => {
    render(<StepUpDialog what="the key" refusal={refusal({ impersonation: true, credentialEmail: 'staff@example.test' })}
      onVerified={vi.fn()} onCancel={vi.fn()} />);
    const note = screen.getByTestId('step-up-impersonation');
    expect(note).toHaveTextContent('staff@example.test');
    expect(note).toHaveTextContent(/your own staff password or passkey/i);
    expect(screen.getByText('Your staff password')).toBeTruthy();
    expect(screen.getByTestId('step-up-passkey')).toHaveTextContent('Confirm with your staff passkey');
  });

  it('says when there is nothing to confirm with', () => {
    render(<StepUpDialog what="the key" refusal={refusal({ methods: [] })} onVerified={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('step-up-no-method')).toBeTruthy();
  });
});

describe('useStepUpGate', () => {
  it('asks on STEP_UP_REQUIRED, then repeats the request once confirmed', async () => {
    const action = vi.fn().mockRejectedValueOnce(stepUpRequired({ impersonation: true, credentialEmail: 'staff@example.test' }))
      .mockResolvedValueOnce('the key');
    apiFetch.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useStepUpGate('the key'));
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => { outcome = result.current.run(action); });
    await waitFor(() => expect(result.current.asking).toBe(true));

    render(<>{result.current.dialog}</>);
    expect(await screen.findByTestId('step-up-impersonation')).toHaveTextContent('staff@example.test');
    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    await expect(outcome).resolves.toBe('the key');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('a cancelled step-up resolves to undefined and does not repeat the request', async () => {
    const action = vi.fn().mockRejectedValueOnce(stepUpRequired());
    const { result } = renderHook(() => useStepUpGate('the key'));
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => { outcome = result.current.run(action); });
    await waitFor(() => expect(result.current.asking).toBe(true));
    render(<>{result.current.dialog}</>);
    fireEvent.click(await screen.findByLabelText('Close'));
    await expect(outcome).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('passes every other error through unchanged', async () => {
    const other = new ApiError(409, 'STEP_UP_UNAVAILABLE', 'No method');
    const { result } = renderHook(() => useStepUpGate('the key'));
    await expect(result.current.run(() => Promise.reject(other))).rejects.toBe(other);
    expect(result.current.asking).toBe(false);
  });
});
