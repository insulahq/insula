import { useSyncExternalStore } from 'react';

/**
 * A single place for "the last file-manager operation failed".
 *
 * WHY: nine file-manager mutation call sites in Files.tsx passed only
 * `onSuccess`. On failure the mutation rejected, nothing rendered, and the
 * dialog sat there looking idle — reported from production as "moving certain
 * files fails without error". The failure was a WAF 403 the whole time, and
 * `apiFetch` had already classified it correctly as WAF_REQUEST_BLOCKED; the
 * message simply had nowhere to go.
 *
 * Adding `onError` to nine call sites would fix those nine. Every mutation
 * defined in `use-file-manager.ts` goes through `useFmMutation`, which reports
 * here automatically, so a new operation cannot silently join the class.
 */

export interface FmError {
  readonly message: string;
  /** Set when the platform recognised the failure as a WAF block. */
  readonly wafBlocked: boolean;
  /** Monotonic id so an identical repeated message still re-renders. */
  readonly seq: number;
}

let current: FmError | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function reportFileManagerError(err: unknown): void {
  const message =
    err instanceof Error && err.message
      ? err.message
      : 'The operation failed. Please try again.';
  // apiFetch surfaces WAF blocks with this code in the message it builds; the
  // banner links straight to WAF Events for those, because the fix is there
  // rather than in anything the tenant can change.
  const wafBlocked = /web application firewall|WAF_REQUEST_BLOCKED/i.test(message);
  current = { message, wafBlocked, seq: ++seq };
  emit();
}

export function clearFileManagerError(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): FmError | null {
  return current;
}

/** Subscribe to the last unacknowledged file-manager failure. */
export function useFileManagerError(): FmError | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam — resets module state between cases. */
export function __resetFileManagerErrors(): void {
  current = null;
  seq = 0;
}
