import { useAuth } from '@/hooks/use-auth';

/**
 * May the current user download a private key or manage cert-download tokens?
 *
 * Deliberately NARROWER than `useCanManage`, which includes `support`. The
 * backend excludes `support` from every key-bearing route
 * (`cert-download/routes.ts` -> requireRole('super_admin','admin','tenant_admin')):
 * support can read certificate metadata but has no business holding a
 * customer's private key. Using the broader gate here renders enabled buttons
 * that 403 on click.
 *
 * Mirrors the "Who may download" table in
 * docs/architecture/TLS_CERTIFICATE_MANAGEMENT.md. This is UX correctness, not
 * the security boundary — the backend is.
 */
export function useCanManageCerts(): boolean {
  const user = useAuth((s) => s.user);
  if (!user?.role) return false;
  return user.role === 'tenant_admin' || user.role === 'super_admin' || user.role === 'admin';
}
