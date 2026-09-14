/**
 * Batch DR recover — the encryption-key preflight panel (ROADMAP R25 §4).
 *
 * The UI's job here is to stop the operator from starting a fleet recover that
 * cannot succeed. So the assertions are about what is NOT on screen: on a
 * mismatch the Recover button must be gone, and the only way past it is a
 * deliberate second control that states what it costs.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const preview = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };
const recover = { data: undefined as unknown, isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() };

vi.mock('@/hooks/use-dr-recover', () => ({
  useDrRecoverAllPreview: () => preview,
  useDrRecoverAll: () => recover,
}));

const { default: RecoverAllTab } = await import('./RecoverAllTab');

const target = () => ({
  tenantId: 't-9',
  tenantName: 'Acme',
  bundleId: 'bundle-abcdef0123456789',
  namespacePresent: false,
  bundleCreatedAt: '2026-09-12T00:00:00.000Z',
  bundleAgeDays: 1,
  components: ['config', 'files'],
});

const keyCheck = (over: Record<string, unknown> = {}) => ({
  verdict: 'ok',
  probed: 2,
  ok: 2,
  failed: 0,
  probes: [],
  summary: 'This cluster decrypted 2 stored credential(s).',
  remedy: null,
  ...over,
});

const MISMATCH = keyCheck({
  verdict: 'mismatch',
  ok: 0,
  failed: 2,
  probes: [
    { source: 'backup_target', ref: 'cfg-1', label: 'offsite', verdict: 'wrong_key' },
    { source: 'image_pull_credential', ref: 'dep-1', label: 'shop', verdict: 'wrong_key' },
  ],
  summary: '2 of 2 stored credential(s) could not be decrypted.',
  remedy: 'Re-bootstrap this cluster with the source cluster\'s PLATFORM_ENCRYPTION_KEY.',
});

function previewWith(encryptionKey: unknown) {
  preview.data = {
    data: {
      dryRun: true, scope: 'missing', total: 1, recovered: 0, failed: 0,
      targets: [target()], skipped: [], encryptionKey,
    },
  };
}

beforeEach(() => {
  preview.data = undefined;
  recover.data = undefined;
  recover.mutate.mockClear();
});

describe('RecoverAllTab — encryption-key preflight', () => {
  it('offers the Recover button when the key checks out', () => {
    previewWith(keyCheck());
    render(<RecoverAllTab />);
    expect(screen.getByText(/Recover 1 tenant/i)).toBeTruthy();
    expect(screen.getByText(/Encryption key verified/i)).toBeTruthy();
  });

  it('WITHHOLDS the Recover button on a mismatch', () => {
    // The refusal is server-side too, but an operator who can click Recover and
    // get a 409 has been told after the fact. The point is to be told before.
    previewWith(MISMATCH);
    render(<RecoverAllTab />);
    expect(screen.queryByText(/Recover 1 tenant/i)).toBeNull();
    expect(screen.getByText(/cannot decrypt 2 of 2 stored credentials/i)).toBeTruthy();
  });

  it('shows the remedy and names every credential that failed', () => {
    previewWith(MISMATCH);
    render(<RecoverAllTab />);
    expect(screen.getByText(/Re-bootstrap this cluster/i)).toBeTruthy();
    // Named so the operator knows what to re-enter if they proceed anyway.
    expect(screen.getByText(/offsite/)).toBeTruthy();
    expect(screen.getByText(/shop/)).toBeTruthy();
  });

  it('restores the Recover button only after an explicit override', () => {
    previewWith(MISMATCH);
    render(<RecoverAllTab />);
    expect(screen.queryByText(/Recover 1 tenant/i)).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /Recover anyway/i }));
    expect(screen.getByText(/Recover 1 tenant/i)).toBeTruthy();
  });

  it('sends the override to the API rather than silently retrying', () => {
    previewWith(MISMATCH);
    render(<RecoverAllTab />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Recover anyway/i }));
    fireEvent.click(screen.getByText(/Recover 1 tenant/i));
    fireEvent.click(screen.getByText(/Confirm recover/i));

    expect(recover.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ allowEncryptionKeyMismatch: true }),
    );
  });

  it('does NOT send the override when the key checked out', () => {
    previewWith(keyCheck());
    render(<RecoverAllTab />);
    fireEvent.click(screen.getByText(/Recover 1 tenant/i));
    fireEvent.click(screen.getByText(/Confirm recover/i));

    expect(recover.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ allowEncryptionKeyMismatch: false }),
    );
  });

  it('an UNVERIFIED check does not read as a pass, and does not block', () => {
    // Nothing was testable, so nothing is claimed — but a fresh-cluster
    // migration must still be possible.
    previewWith(keyCheck({ verdict: 'unverified', probed: 0, ok: 0, failed: 0, summary: 'could not be checked' }));
    render(<RecoverAllTab />);
    expect(screen.queryByText(/Encryption key verified/i)).toBeNull();
    expect(screen.getByText(/Encryption key not verified/i)).toBeTruthy();
    expect(screen.getByText(/Recover 1 tenant/i)).toBeTruthy();
  });

  it('reports the verdict from the RUN once there is one', () => {
    // A run launched from a stale preview carries the verdict that applied.
    previewWith(keyCheck());
    recover.data = {
      data: {
        dryRun: false, scope: 'missing', total: 1, recovered: 0, failed: 1,
        results: [{ ...target(), ok: false, status: 'failed', recreated: false, error: 'x' }],
        skipped: [], encryptionKey: MISMATCH,
      },
    };
    render(<RecoverAllTab />);
    expect(screen.getByText(/cannot decrypt 2 of 2 stored credentials/i)).toBeTruthy();
    expect(screen.queryByText(/Encryption key verified/i)).toBeNull();
  });
});
