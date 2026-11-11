import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTerminal } from '../hooks/use-container-console';

vi.mock('../hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 'tenant-1' }),
}));

// The shell the terminal asks for and the size it starts at travel on the
// socket URL; later sizes as `resize` messages the backend now applies.
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.last = this; }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
}

describe('useTerminal', () => {
  const original = globalThis.WebSocket;
  beforeEach(() => { FakeSocket.last = null; (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket; });
  afterEach(() => { (globalThis as { WebSocket: unknown }).WebSocket = original; });

  it('asks for the auto shell by default, at the size the terminal has', () => {
    const { result } = renderHook(() => useTerminal('dep-1', { component: 'web' }));
    act(() => result.current.connect(() => undefined, { cols: 132, rows: 40 }));

    const url = new URL(FakeSocket.last!.url);
    expect(url.pathname).toBe('/api/v1/tenants/tenant-1/deployments/dep-1/terminal');
    expect(url.searchParams.get('shell')).toBe('auto');
    expect(url.searchParams.get('cols')).toBe('132');
    expect(url.searchParams.get('rows')).toBe('40');
  });

  it('keeps an explicit shell choice', () => {
    const { result } = renderHook(() => useTerminal('dep-1', { shell: '/bin/sh' }));
    act(() => result.current.connect(() => undefined));
    expect(new URL(FakeSocket.last!.url).searchParams.get('shell')).toBe('/bin/sh');
  });

  it('sends arrow-up, Tab and a resize unchanged once open', () => {
    const { result } = renderHook(() => useTerminal('dep-1'));
    act(() => result.current.connect(() => undefined));
    act(() => FakeSocket.last!.open());
    act(() => {
      result.current.send('\x1b[A');
      result.current.send('\t');
      result.current.resize(100, 30);
    });
    expect(FakeSocket.last!.sent.map((m) => JSON.parse(m))).toEqual([
      { type: 'stdin', data: '\x1b[A' },
      { type: 'stdin', data: '\t' },
      { type: 'resize', cols: 100, rows: 30 },
    ]);
  });
});
