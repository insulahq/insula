import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useFileManagerError,
  reportFileManagerError,
  clearFileManagerError,
  __resetFileManagerErrors,
} from '@/hooks/use-file-manager-errors';

// WHY THIS EXISTS: nine file-manager mutation call sites in Files.tsx passed
// only `onSuccess`. A WAF 403 on rename or move therefore rejected the
// mutation and rendered nothing — reported from production as "accessing/
// moving certain files fails without error". apiFetch had already classified
// the failure correctly; the message had nowhere to go.

describe('file-manager error surface', () => {
  beforeEach(() => __resetFileManagerErrors());

  it('starts with nothing to show', () => {
    const { result } = renderHook(() => useFileManagerError());
    expect(result.current).toBeNull();
  });

  it('surfaces a failure to subscribers', () => {
    const { result } = renderHook(() => useFileManagerError());
    act(() => reportFileManagerError(new Error('Failed to rename file')));
    expect(result.current?.message).toBe('Failed to rename file');
    expect(result.current?.wafBlocked).toBe(false);
  });

  it('flags a WAF block, so the banner can explain a 403 the tenant cannot fix', () => {
    const { result } = renderHook(() => useFileManagerError());
    act(() => reportFileManagerError(new Error(
      'Blocked by the Web Application Firewall. The request never reached the platform API — ' +
      'a security rule matched its contents.',
    )));
    expect(result.current?.wafBlocked).toBe(true);
  });

  it('re-renders on an identical repeated failure', () => {
    // Renaming .htaccess twice produces the same message. Without a changing
    // key the banner would look stale and the second attempt would appear to
    // have done nothing — the exact symptom being fixed.
    const { result } = renderHook(() => useFileManagerError());
    act(() => reportFileManagerError(new Error('same')));
    const first = result.current?.seq;
    act(() => reportFileManagerError(new Error('same')));
    expect(result.current?.seq).toBeGreaterThan(first!);
  });

  it('can be dismissed', () => {
    const { result } = renderHook(() => useFileManagerError());
    act(() => reportFileManagerError(new Error('boom')));
    expect(result.current).not.toBeNull();
    act(() => clearFileManagerError());
    expect(result.current).toBeNull();
  });

  it('never renders an empty message', () => {
    const { result } = renderHook(() => useFileManagerError());
    act(() => reportFileManagerError({ not: 'an error' }));
    expect(result.current?.message).toMatch(/\S/);
  });
});
