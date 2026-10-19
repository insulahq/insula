/**
 * Where "Login as tenant" may land: a path inside this panel, never a URL.
 *
 * The admin panel opens `/login?token=…&user=…&next=/email/mailboxes` so an
 * operator lands on the page a link was about. `next` arrives in a URL anyone
 * can craft, so an absolute or protocol-relative value (`https://evil.test`,
 * `//evil.test`, `/\evil.test`) must never be followed — it would hand a
 * freshly signed-in session to another site. Anything that does not resolve
 * to this origin falls back to the home page.
 */
const BASE = 'https://tenant-panel.invalid';

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '/';
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return '/';
  }
  if (url.origin !== BASE) return '/';
  // The login page itself would loop straight back here.
  if (url.pathname === '/login') return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
