import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';

/**
 * Default landing for `/platform`. Super-admins go straight to the canonical
 * Upgrades page (pre-flight → interruption preview → confirm → live progress);
 * everyone else lands on the read-only Updates overview (Upgrades is
 * super_admin-only, so a plain <Navigate> there would show "Access Denied").
 */
export default function PlatformIndexRedirect() {
  const { user } = useAuth();
  const to = user?.role === 'super_admin' ? '/platform/upgrades' : '/platform/updates';
  return <Navigate to={to} replace />;
}
