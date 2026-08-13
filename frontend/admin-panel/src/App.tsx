import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TASK_CENTER_QUERY_KEY } from '@/hooks/use-task-center';
import Layout from '@/components/layout/Layout';
import ProtectedRoute from '@/components/layout/ProtectedRoute';
import { NodeTerminalHost } from '@/components/NodeTerminalHost';
const Login = lazy(() => import('@/pages/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TenantsLayout = lazy(() => import('@/pages/tenants/TenantsLayout'));
const TenantsListTab = lazy(() => import('@/pages/tenants/TenantsListTab'));
const DomainsTab = lazy(() => import('@/pages/tenants/DomainsTab'));
const WorkloadsTab = lazy(() => import('@/pages/tenants/WorkloadsTab'));
const UsersTab = lazy(() => import('@/pages/tenants/UsersTab'));
const EmailAccountsTab = lazy(() => import('@/pages/tenants/EmailAccountsTab'));
const CronJobsTab = lazy(() => import('@/pages/tenants/CronJobsTab'));
const TenantDetail = lazy(() => import('@/pages/TenantDetail'));
const Monitoring = lazy(() => import('@/pages/Monitoring'));
const Applications = lazy(() => import('@/pages/Applications'));
const UserSettings = lazy(() => import('@/pages/UserSettings'));
const DomainDetail = lazy(() => import('@/pages/DomainDetail'));
const RestoreCartPage = lazy(() => import('@/pages/RestoreCart'));
const BackupsDashboard = lazy(() => import('@/pages/backups/BackupsDashboard'));
const SystemBackupsPage = lazy(() => import('@/pages/backups/SystemBackupsPage'));
const TenantsBackupsPage = lazy(() => import('@/pages/backups/TenantsBackupsPage'));
const MailBackupsPage = lazy(() => import('@/pages/backups/MailBackupsPage'));
const RemoteStorageTargetsPage = lazy(() => import('@/pages/backups/RemoteStorageTargetsPage'));
const DisasterRecoveryPage = lazy(() => import('@/pages/backups/DisasterRecoveryPage'));
const EmailDomainsPage = lazy(() => import('@/pages/email/EmailDomainsPage'));
const EmailSettingsPage = lazy(() => import('@/pages/email/EmailSettingsPage'));
const EmailOperationsPage = lazy(() => import('@/pages/email/EmailOperationsPage'));
const EmailDriftPage = lazy(() => import('@/pages/email/EmailDriftPage'));
const AuditLogs = lazy(() => import('@/pages/AuditLogs'));
const Placeholder = lazy(() => import('@/pages/Placeholder'));
// Cluster group (operations / infrastructure)
const NodesPage = lazy(() => import('@/pages/cluster/NodesPage'));
const StoragePage = lazy(() => import('@/pages/cluster/StoragePage'));
const ClusterPoliciesPage = lazy(() => import('@/pages/cluster/ClusterPoliciesPage'));
const NetworkingPage = lazy(() => import('@/pages/cluster/NetworkingPage'));
const IngressTlsPage = lazy(() => import('@/pages/cluster/IngressTlsPage'));
const LoadBalancerPage = lazy(() => import('@/pages/cluster/LoadBalancerPage'));
const TunnelsPage = lazy(() => import('@/pages/cluster/TunnelsPage'));
// Platform Settings group (product configuration)
const UpgradesPage = lazy(() => import('@/pages/platform/UpgradesPage'));
const IdentityPage = lazy(() => import('@/pages/platform/IdentityPage'));
const LimitsPage = lazy(() => import('@/pages/platform/LimitsPage'));
const IntegrationsPage = lazy(() => import('@/pages/platform/IntegrationsPage'));
const DnsProvidersPage = lazy(() => import('@/pages/platform/DnsProvidersPage'));
const PlansPage = lazy(() => import('@/pages/platform/PlansPage'));
const PleskMigrationPage = lazy(() => import('@/pages/platform/PleskMigrationPage'));
const AiPage = lazy(() => import('@/pages/platform/AiPage'));
const LifecycleHooksPage = lazy(() => import('@/pages/platform/LifecycleHooksPage'));
const NotificationsPage = lazy(() => import('@/pages/platform/NotificationsPage'));
const ExportImportPage = lazy(() => import('@/pages/platform/ExportImportPage'));
// Security group
const IdentityAndSessionsPage = lazy(() => import('@/pages/IdentityAndSessionsPage'));
const NetworkTrustPage = lazy(() => import('@/pages/NetworkTrustPage'));
const PosturePage = lazy(() => import('@/pages/PosturePage'));
const WebDefensePage = lazy(() => import('@/pages/WebDefensePage'));
const OidcPage = lazy(() => import('@/pages/security/OidcPage'));
import ErrorBoundary from '@/components/ErrorBoundary';
import RouteFallback from '@/components/RouteFallback';

// MutationCache subscriber: refresh the Task Center chip after every
// successful mutation. Long-running ops register a `tasks` row inside
// their handler, so the chip needs to refetch right after the trigger
// resolves — without this, the row only appears on the next 3 s poll
// tick and the chip looks unresponsive. Per-mutation `onSuccess` opt-in
// would work too but is easy to forget; doing it once globally is the
// safer floor. The /me/tasks endpoint is small + per-user so the extra
// refetch is cheap.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      // Skip chip-internal mutations (clear/etc) to avoid refetch loops.
      const key = mutation.options.mutationKey;
      if (Array.isArray(key) && key[0] === 'task-center') return;
      void queryClient.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
    },
  }),
});

export default function App() {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                {/* App-level mount for the node-terminal host so its
                    modal + dock survive page navigation. Terminal
                    sessions started on one page stay alive when the
                    operator navigates elsewhere — the dock surfaces
                    them as restorable pills. */}
                <NodeTerminalHost />
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="tenants" element={<TenantsLayout />}>
              <Route index element={<Navigate to="list" replace />} />
              <Route path="list" element={<TenantsListTab />} />
              <Route path="domains" element={<DomainsTab />} />
              <Route path="workloads" element={<WorkloadsTab />} />
              <Route path="users" element={<UsersTab />} />
              <Route path="email-accounts" element={<EmailAccountsTab />} />
              <Route path="cron-jobs" element={<CronJobsTab />} />
            </Route>
            <Route path="tenants/:id" element={<TenantDetail />} />
            <Route path="tenants/:tenantId/domains/:domainId" element={<DomainDetail />} />
            <Route path="applications" element={<Applications />} />
            <Route path="backups" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><BackupsDashboard /></ProtectedRoute>} />
            <Route path="backups/system" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><SystemBackupsPage /></ProtectedRoute>} />
            <Route path="backups/tenants" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><TenantsBackupsPage /></ProtectedRoute>} />
            <Route path="backups/mail" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><MailBackupsPage /></ProtectedRoute>} />
            <Route path="backups/targets" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><RemoteStorageTargetsPage /></ProtectedRoute>} />
            <Route path="backups/disaster-recovery" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><DisasterRecoveryPage /></ProtectedRoute>} />
            {/* Security Hub */}
            <Route path="security" element={<Navigate to="/security/posture" replace />} />
            <Route path="security/posture" element={<ProtectedRoute allowedRoles={['super_admin']}><PosturePage /></ProtectedRoute>} />
            <Route path="security/network-trust" element={<ProtectedRoute allowedRoles={['super_admin']}><NetworkTrustPage /></ProtectedRoute>} />
            <Route path="security/identity" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><IdentityAndSessionsPage /></ProtectedRoute>} />
            <Route path="security/web-defense" element={<ProtectedRoute allowedRoles={['super_admin']}><WebDefensePage /></ProtectedRoute>} />
            <Route path="security/oidc" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><OidcPage /></ProtectedRoute>} />

            {/* Monitoring */}
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="monitoring/audit-logs" element={<AuditLogs />} />

            {/* Email */}
            <Route path="email" element={<Navigate to="/email/domains" replace />} />
            <Route path="email/domains" element={<EmailDomainsPage />} />
            <Route path="email/settings" element={<EmailSettingsPage />} />
            <Route path="email/operations" element={<EmailOperationsPage />} />
            <Route path="email/drift" element={<EmailDriftPage />} />

            {/* Cluster — operations / infrastructure (replaces standalone
                Nodes & Storage + the cluster-relevant slices of the
                retired /settings/* tree). */}
            <Route path="cluster" element={<Navigate to="/cluster/nodes" replace />} />
            <Route path="cluster/nodes" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><NodesPage /></ProtectedRoute>} />
            <Route path="cluster/storage" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><StoragePage /></ProtectedRoute>} />
            <Route path="cluster/cluster-policies" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><ClusterPoliciesPage /></ProtectedRoute>} />
            <Route path="cluster/networking" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><NetworkingPage /></ProtectedRoute>} />
            <Route path="cluster/ingress-tls" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><IngressTlsPage /></ProtectedRoute>} />
            <Route path="cluster/load-balancer" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><LoadBalancerPage /></ProtectedRoute>} />
            <Route path="cluster/tunnels" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><TunnelsPage /></ProtectedRoute>} />

            {/* Platform Settings — product configuration (replaces the
                retired /settings catch-all + standalone /settings/*
                child routes). */}
            {/* Single consolidated page. /platform/upgrades kept as a redirect for old links. */}
            <Route path="platform" element={<Navigate to="/platform/updates" replace />} />
            <Route path="platform/updates" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><UpgradesPage /></ProtectedRoute>} />
            <Route path="platform/upgrades" element={<Navigate to="/platform/updates" replace />} />
            <Route path="platform/identity" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><IdentityPage /></ProtectedRoute>} />
            <Route path="platform/plans" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><PlansPage /></ProtectedRoute>} />
            <Route path="platform/plesk-migration" element={<ProtectedRoute allowedRoles={['super_admin']}><PleskMigrationPage /></ProtectedRoute>} />
            <Route path="platform/limits" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><LimitsPage /></ProtectedRoute>} />
            <Route path="platform/dns" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><DnsProvidersPage /></ProtectedRoute>} />
            <Route path="platform/integrations" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><IntegrationsPage /></ProtectedRoute>} />
            <Route path="platform/ai" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><AiPage /></ProtectedRoute>} />
            <Route path="platform/lifecycle-hooks" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><LifecycleHooksPage /></ProtectedRoute>} />
            <Route path="platform/notifications" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><NotificationsPage /></ProtectedRoute>} />
            <Route path="platform/export-import" element={<ProtectedRoute allowedRoles={['super_admin']}><ExportImportPage /></ProtectedRoute>} />

            {/* Tenant-bundle restore cart — reachable from the Restoration
                Wizard modal when the artifact is a tenant bundle. No
                sidebar entry; the Wizard supplies the entry point. */}
            <Route path="backups/restore" element={<ProtectedRoute allowedRoles={['super_admin', 'admin']}><RestoreCartPage /></ProtectedRoute>} />

            <Route path="user-settings" element={<UserSettings />} />
            <Route path="*" element={<Placeholder title="Page Not Found" />} />
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
