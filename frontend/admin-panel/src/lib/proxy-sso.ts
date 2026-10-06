/**
 * Single sign-on behind the panel's OAuth2 Proxy.
 *
 * A proxy-protected panel is only reachable AFTER the visitor signed in to the
 * proxy's identity provider, so its login page can start that same provider's
 * sign-in on its own: the IdP still holds the session it just created and
 * answers without asking again. Without this the visitor logs in twice.
 *
 * The login page otherwise never redirects by itself (see Login.tsx) — that
 * rule exists because an automatic redirect makes the page a dead end. Each
 * guard below keeps one of those cases reachable:
 *  - after an explicit sign-out (to switch accounts) — suppressed for the tab;
 *  - when the callback came back with `?error=` — the message must be readable;
 *  - when a sign-in already started moments ago and landed back here (no linked
 *    account, provider failure) — at most one automatic attempt per window.
 */
const ATTEMPT_KEY = 'insula.proxySso.attemptedAt';
const SUPPRESS_KEY = 'insula.proxySso.suppressed';
export const PROXY_SSO_RETRY_WINDOW_MS = 120_000;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

export interface ProxySsoInput {
  readonly proxyProviderId: string | null | undefined;
  readonly providerIds: readonly string[];
  /** `?token=` / `?error=` present: a callback is being handled or reported. */
  readonly callbackInProgress: boolean;
  readonly storage: ReadStorage;
  readonly now: number;
}

export function proxySsoProvider(input: ProxySsoInput): string | null {
  const id = input.proxyProviderId;
  if (!id || !input.providerIds.includes(id) || input.callbackInProgress) return null;
  try {
    if (input.storage.getItem(SUPPRESS_KEY) === '1') return null;
    const last = Number(input.storage.getItem(ATTEMPT_KEY) ?? 0);
    if (Number.isFinite(last) && input.now - last < PROXY_SSO_RETRY_WINDOW_MS) return null;
  } catch {
    // Storage unavailable (privacy mode): no loop guard, so do not auto-start.
    return null;
  }
  return id;
}

export function markProxySsoAttempt(storage: WriteStorage, now: number): void {
  try { storage.setItem(ATTEMPT_KEY, String(now)); } catch { /* best effort */ }
}

/** Called on an explicit sign-out: the visitor stays on the login page this tab. */
export function suppressProxySso(storage: WriteStorage): void {
  try { storage.setItem(SUPPRESS_KEY, '1'); } catch { /* best effort */ }
}

/** Called once a sign-in completed: the next expired session may auto-start again. */
export function resetProxySso(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(SUPPRESS_KEY);
    storage.removeItem(ATTEMPT_KEY);
  } catch { /* best effort */ }
}
