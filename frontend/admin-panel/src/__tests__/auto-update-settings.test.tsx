/**
 * ADR-064 §7: automatic updates act only inside a saved maintenance window, and
 * the page says what they did last. Only a super_admin may change them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutoUpdateSettings from '@/components/platform/AutoUpdateSettings';
import type { PlatformVersionData } from '@/hooks/use-platform-updates';

const mutate = vi.fn();
vi.mock('@/hooks/use-platform-updates', () => ({
  useUpdateSettings: () => ({ mutate, isPending: false, error: null }),
}));

const base = { autoUpdate: true, maintenanceWindow: null, autoUpdateStatus: null } as unknown as PlatformVersionData;

beforeEach(() => mutate.mockReset());

describe('AutoUpdateSettings', () => {
  it('on without a window: says it does nothing until one is saved, and saves the edited window', () => {
    render(<AutoUpdateSettings v={base} canEdit />);
    expect(screen.getByTestId('window-missing')).toHaveTextContent(/do nothing until one is/);
    fireEvent.click(screen.getByTestId('window-day-3'));
    fireEvent.change(screen.getByTestId('window-start'), { target: { value: '01:30' } });
    fireEvent.change(screen.getByTestId('window-tz'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByTestId('window-save'));
    expect(mutate).toHaveBeenCalledWith(
      { autoUpdate: true, maintenanceWindow: { days: [0, 3], start: '01:30', end: '05:00', timeZone: 'UTC' } },
      expect.anything(),
    );
  });

  it('turning it off sends only the toggle (the window is kept)', () => {
    render(<AutoUpdateSettings v={base} canEdit />);
    fireEvent.click(screen.getByTestId('auto-update-toggle'));
    expect(mutate).toHaveBeenCalledWith({ autoUpdate: false });
  });

  it('shows what automatic updates did last', () => {
    const v = { ...base, maintenanceWindow: { days: [0], start: '02:00', end: '05:00', timeZone: 'UTC' },
      autoUpdateStatus: { state: 'waiting-window', detail: '2026.10.8 applies in the next maintenance window: Sun 02:00–05:00 (UTC).', target: '2026.10.8', checkedAt: '2026-10-09T12:00:00Z' } } as unknown as PlatformVersionData;
    render(<AutoUpdateSettings v={v} canEdit />);
    expect(screen.getByTestId('auto-update-status')).toHaveTextContent(/applies in the next maintenance window/);
    expect(screen.queryByTestId('window-missing')).toBeNull();
    expect(screen.queryByTestId('window-save')).toBeNull(); // nothing changed
  });

  it('a role that cannot change it sees it read-only', () => {
    render(<AutoUpdateSettings v={base} canEdit={false} />);
    expect(screen.getByTestId('auto-update-toggle')).toBeDisabled();
    expect(screen.queryByTestId('window-save')).toBeNull();
  });
});
