import type { RegistryEntry } from './match';

/**
 * Every destination in the admin panel that global search can reach.
 *
 * Hand-authored on purpose. Deriving it from the Sidebar would only ever
 * yield page-level entries, and most of what an operator hunts for is a
 * TAB — "WAF events", "Pods", "Trusted proxies" are all one level below
 * a nav item. Deriving it from the JSX would mean parsing component
 * source at build time for labels that move around constantly.
 *
 * The cost of hand-authoring is drift: add a page, forget an entry, and
 * the page is simply unfindable with nothing failing anywhere. That is
 * what `scripts/ci-search-registry-check.sh` is for — it fails the build
 * on a route with no entry, an entry pointing at a route that does not
 * exist, and a `?tab=` value absent from the target page's tab union.
 *
 * `roles` MUST mirror the route's `allowedRoles` in App.tsx. When you
 * change one, change the other.
 */
export const ADMIN_SEARCH_REGISTRY: readonly RegistryEntry[] = [
  // ─── Top level ─────────────────────────────────────────────────────────────
  { id: 'dashboard', label: 'Dashboard', group: 'Overview', to: '/',
    keywords: ['home', 'start', 'summary', 'overview'] },

  // ─── Tenants ───────────────────────────────────────────────────────────────
  { id: 'tenants.list', label: 'Tenants', group: 'Tenants', to: '/tenants/list',
    keywords: ['customers', 'accounts', 'clients', 'subscribers'] },
  { id: 'tenants.domains', label: 'Domains', group: 'Tenants', to: '/tenants/domains',
    keywords: ['hostnames', 'sites', 'dns', 'zones'] },
  { id: 'tenants.workloads', label: 'Workloads', group: 'Tenants', to: '/tenants/workloads',
    keywords: ['deployments', 'apps', 'containers', 'pods'] },
  { id: 'tenants.users', label: 'Tenant Users', group: 'Tenants', to: '/tenants/users',
    keywords: ['sub-users', 'logins', 'accounts', 'people'] },
  { id: 'tenants.email-accounts', label: 'Email Accounts', group: 'Tenants', to: '/tenants/email-accounts',
    keywords: ['mailboxes', 'inboxes', 'addresses', 'imap'] },
  { id: 'tenants.cron-jobs', label: 'Scheduled Tasks', group: 'Tenants', to: '/tenants/cron-jobs',
    keywords: ['cron', 'crontab', 'jobs', 'timers', 'schedules'] },

  // ─── Applications ──────────────────────────────────────────────────────────
  { id: 'applications.installed', label: 'Installed Applications', group: 'Applications', to: '/applications?tab=installed',
    keywords: ['deployments', 'running', 'instances'] },
  { id: 'applications.catalog', label: 'Application Catalog', group: 'Applications', to: '/applications?tab=catalog',
    keywords: ['marketplace', 'store', 'templates', 'wordpress', 'available'] },
  { id: 'applications.upgrades', label: 'Application Upgrades', group: 'Applications', to: '/applications?tab=upgrades',
    keywords: ['updates', 'versions', 'bump', 'outdated'] },
  { id: 'applications.repos', label: 'Catalog Repositories', group: 'Applications', to: '/applications?tab=repos',
    keywords: ['sources', 'git', 'community', 'official'] },

  // ─── Backups ───────────────────────────────────────────────────────────────
  { id: 'backups.dashboard', label: 'Backups', group: 'Backups', to: '/backups',
    roles: ['super_admin', 'admin'], keywords: ['overview', 'restore', 'snapshots'] },
  { id: 'backups.system.snapshots', label: 'System Snapshots', group: 'Backups → System', to: '/backups/system?tab=snapshots',
    roles: ['super_admin', 'admin'], keywords: ['platform', 'volume', 'longhorn', 'pvc'] },
  { id: 'backups.system.backups', label: 'System Backups', group: 'Backups → System', to: '/backups/system?tab=backups',
    roles: ['super_admin', 'admin'], keywords: ['platform', 'database', 'postgres', 'restic'] },
  { id: 'backups.system.routing', label: 'System Targets, Schedules & Retention', group: 'Backups → System', to: '/backups/system?tab=routing',
    roles: ['super_admin', 'admin'], keywords: ['retention', 'schedule', 'cron', 'target', 'wal'] },
  { id: 'backups.tenants.snapshots', label: 'Tenant Snapshots', group: 'Backups → Tenants', to: '/backups/tenants?tab=snapshots',
    roles: ['super_admin', 'admin'], keywords: ['volume', 'pvc', 'longhorn'] },
  { id: 'backups.tenants.backups', label: 'Tenant Backups', group: 'Backups → Tenants', to: '/backups/tenants?tab=backups',
    roles: ['super_admin', 'admin'], keywords: ['bundle', 'restic', 'export'] },
  { id: 'backups.tenants.routing', label: 'Tenant Targets, Schedules & Retention', group: 'Backups → Tenants', to: '/backups/tenants?tab=routing',
    roles: ['super_admin', 'admin'], keywords: ['retention', 'schedule', 'target'] },
  { id: 'backups.mail.snapshots', label: 'Mail Snapshots', group: 'Backups → Mail', to: '/backups/mail?tab=snapshots',
    roles: ['super_admin', 'admin'], keywords: ['stalwart', 'volume'] },
  { id: 'backups.mail.backups', label: 'Mail Backups', group: 'Backups → Mail', to: '/backups/mail?tab=backups',
    roles: ['super_admin', 'admin'], keywords: ['stalwart', 'mailbox', 'restic'] },
  { id: 'backups.mail.routing', label: 'Mail Targets, Schedules & Retention', group: 'Backups → Mail', to: '/backups/mail?tab=routing',
    roles: ['super_admin', 'admin'], keywords: ['retention', 'schedule', 'target'] },
  { id: 'backups.targets', label: 'Remote Storage Targets', group: 'Backups', to: '/backups/targets',
    roles: ['super_admin', 'admin'], keywords: ['s3', 'sftp', 'cifs', 'smb', 'offsite', 'repository', 'rclone'] },
  { id: 'backups.dr', label: 'Disaster Recovery', group: 'Backups', to: '/backups/disaster-recovery',
    roles: ['super_admin', 'admin'], keywords: ['dr', 'drill', 'recover', 'rebuild', 'restore key'] },

  // ─── Security ──────────────────────────────────────────────────────────────
  { id: 'security.posture.overview', label: 'Security Posture', group: 'Security → Posture', to: '/security/posture?tab=overview',
    roles: ['super_admin'], keywords: ['hardening', 'cis', 'compliance', 'score'] },
  { id: 'security.posture.ssh', label: 'SSH Lockdown', group: 'Security → Posture', to: '/security/posture?tab=ssh',
    roles: ['super_admin'], keywords: ['sshd', 'port 22', 'mesh', 'root login'] },
  { id: 'security.posture.mesh', label: 'Mesh Status', group: 'Security → Posture', to: '/security/posture?tab=mesh',
    roles: ['super_admin'], keywords: ['netbird', 'vpn', 'wireguard', 'overlay'] },
  { id: 'security.posture.firewall', label: 'Firewall Posture', group: 'Security → Posture', to: '/security/posture?tab=firewall',
    roles: ['super_admin'], keywords: ['nftables', 'iptables', 'ports', 'ingress rules'] },
  { id: 'security.posture.hardening', label: 'Node Hardening', group: 'Security → Posture', to: '/security/posture?tab=hardening',
    roles: ['super_admin'], keywords: ['kernel', 'sysctl', 'unattended upgrades', 'os updates'] },
  { id: 'security.posture.k8s', label: 'Kubernetes Posture', group: 'Security → Posture', to: '/security/posture?tab=k8s',
    roles: ['super_admin'], keywords: ['k3s', 'rbac', 'psa', 'admission'] },
  { id: 'security.posture.auth', label: 'Authentication Posture', group: 'Security → Posture', to: '/security/posture?tab=auth',
    roles: ['super_admin'], keywords: ['password policy', 'mfa', '2fa', 'passkey'] },
  { id: 'security.posture.netpol', label: 'Network Policies', group: 'Security → Posture', to: '/security/posture?tab=netpol',
    roles: ['super_admin'], keywords: ['calico', 'netpol', 'isolation', 'egress'] },
  { id: 'security.posture.events', label: 'Security Events', group: 'Security → Posture', to: '/security/posture?tab=events',
    roles: ['super_admin'], keywords: ['audit', 'alerts', 'incidents'] },
  { id: 'security.network-trust.ranges', label: 'Trusted Ranges', group: 'Security → Network Trust', to: '/security/network-trust?tab=trusted-ranges',
    roles: ['super_admin'], keywords: ['cidr', 'allowlist', 'whitelist', 'subnet'] },
  { id: 'security.network-trust.peers', label: 'Pending Peers', group: 'Security → Network Trust', to: '/security/network-trust?tab=pending-peers',
    roles: ['super_admin'], keywords: ['enroll', 'join', 'node', 'cluster peer'] },
  { id: 'security.network-trust.proxies', label: 'Trusted Proxies', group: 'Security → Network Trust', to: '/security/network-trust?tab=trusted-proxies',
    roles: ['super_admin'], keywords: ['x-forwarded-for', 'cloudflare', 'real ip', 'cdn'] },
  { id: 'security.network-trust.blacklist', label: 'Blacklist', group: 'Security → Network Trust', to: '/security/network-trust?tab=blacklist',
    roles: ['super_admin'], keywords: ['blocklist', 'deny', 'banned', 'block ip'] },
  { id: 'security.identity', label: 'Identity & Sessions', group: 'Security', to: '/security/identity',
    roles: ['super_admin', 'admin'], keywords: ['admin users', 'logins', 'passkeys', 'mfa', '2fa', 'revoke', 'sessions'] },
  { id: 'security.web-defense.waf', label: 'WAF Events', group: 'Security → Web Defense', to: '/security/web-defense?tab=waf',
    roles: ['super_admin'], keywords: ['modsecurity', 'coraza', 'crs', 'owasp', 'blocked requests', 'firewall'] },
  { id: 'security.web-defense.bans', label: 'Banned IPs', group: 'Security → Web Defense', to: '/security/web-defense?tab=bans',
    roles: ['super_admin'], keywords: ['crowdsec', 'ban', 'block', 'decisions', 'bouncer'] },
  { id: 'security.web-defense.exclusions', label: 'WAF Exclusions', group: 'Security → Web Defense', to: '/security/web-defense?tab=exclusions',
    roles: ['super_admin'], keywords: ['false positive', 'rule exclusion', 'allowlist', 'crs rule'] },
  { id: 'security.web-defense.settings', label: 'WAF Settings', group: 'Security → Web Defense', to: '/security/web-defense?tab=settings',
    roles: ['super_admin'], keywords: ['crowdsec', 'auto-ban', 'l4', 'detection', 'paranoia'] },
  { id: 'security.oidc', label: 'OIDC / SSO', group: 'Security', to: '/security/oidc',
    roles: ['super_admin', 'admin'], keywords: ['dex', 'single sign-on', 'openid', 'saml', 'idp', 'login provider'] },

  // ─── Monitoring ────────────────────────────────────────────────────────────
  { id: 'monitoring.active-alerts', label: 'Active Alerts', group: 'Monitoring', to: '/monitoring?tab=active-alerts',
    keywords: ['firing', 'incidents', 'warnings', 'paging'] },
  { id: 'monitoring.alert-history', label: 'Alert History', group: 'Monitoring', to: '/monitoring?tab=alert-history',
    keywords: ['resolved', 'past alerts', 'timeline'] },
  { id: 'monitoring.activity', label: 'Activity', group: 'Monitoring', to: '/monitoring?tab=activity',
    keywords: ['events', 'recent', 'changes'] },
  { id: 'monitoring.health', label: 'Platform Health', group: 'Monitoring', to: '/monitoring?tab=health',
    keywords: ['checks', 'status', 'uptime', 'probes'] },
  { id: 'monitoring.node-health', label: 'Node Health', group: 'Monitoring', to: '/monitoring?tab=node-health',
    keywords: ['memory', 'oom', 'pressure', 'cpu', 'disk'] },
  { id: 'monitoring.storage', label: 'Storage Usage', group: 'Monitoring', to: '/monitoring?tab=storage',
    keywords: ['disk', 'capacity', 'pvc', 'volumes', 'full'] },
  { id: 'monitoring.pods', label: 'Pods', group: 'Monitoring', to: '/monitoring?tab=pods',
    keywords: ['containers', 'restarts', 'crashloop', 'prune', 'dead pods', 'evicted'] },
  { id: 'monitoring.slos', label: 'SLOs', group: 'Monitoring', to: '/monitoring?tab=slos',
    keywords: ['latency', 'error budget', 'availability', 'objectives'] },
  { id: 'monitoring.mail', label: 'Mail Monitoring', group: 'Monitoring', to: '/monitoring?tab=mail',
    keywords: ['queue', 'delivery', 'stalwart', 'smtp', 'dmarc'] },
  { id: 'monitoring.audit-logs', label: 'Audit Logs', group: 'Monitoring', to: '/monitoring/audit-logs',
    keywords: ['who did what', 'trail', 'history', 'changes', 'compliance'] },

  // ─── Email ─────────────────────────────────────────────────────────────────
  { id: 'email.domains', label: 'Email Domains & Relays', group: 'Email', to: '/email/domains',
    keywords: ['dkim', 'spf', 'dmarc', 'mx', 'smtp relay', 'sending domains'] },
  { id: 'email.settings.mail', label: 'Mail Server Settings', group: 'Email → Settings', to: '/email/settings?tab=mail',
    keywords: ['stalwart', 'smtp', 'imap', 'jmap', 'ports', 'tls'] },
  { id: 'email.settings.webmail', label: 'Webmail Settings', group: 'Email → Settings', to: '/email/settings?tab=webmail',
    keywords: ['roundcube', 'bulwark', 'default client', 'calendar', 'contacts'] },
  { id: 'email.settings.bundle-engine', label: 'Mail Backup Engine', group: 'Email → Settings', to: '/email/settings?tab=bundle-engine',
    keywords: ['backup', 'restic', 'bundle'] },
  { id: 'email.operations.placement', label: 'Mail Placement & Migration', group: 'Email → Operations', to: '/email/operations?tab=placement',
    keywords: ['node', 'move', 'imapsync', 'migrate'] },
  { id: 'email.operations.backups', label: 'Mail Operations Backups', group: 'Email → Operations', to: '/email/operations?tab=backups',
    keywords: ['restore', 'snapshot'] },
  { id: 'email.operations.storage', label: 'Mail Storage', group: 'Email → Operations', to: '/email/operations?tab=storage',
    keywords: ['quota', 'disk', 'volume', 'usage'] },
  { id: 'email.drift', label: 'Mail Data Drift', group: 'Email', to: '/email/drift',
    keywords: ['reconcile', 'mismatch', 'stalwart', 'orphans'] },

  // ─── Cluster ───────────────────────────────────────────────────────────────
  { id: 'cluster.nodes', label: 'Nodes', group: 'Cluster', to: '/cluster/nodes',
    roles: ['super_admin', 'admin'], keywords: ['servers', 'workers', 'machines', 'drain', 'cordon', 'k3s'] },
  { id: 'cluster.storage', label: 'Storage', group: 'Cluster', to: '/cluster/storage',
    roles: ['super_admin', 'admin'], keywords: ['longhorn', 'pvc', 'volumes', 'replicas', 'disks'] },
  { id: 'cluster.policies', label: 'Cluster Policies', group: 'Cluster', to: '/cluster/cluster-policies',
    roles: ['super_admin', 'admin'], keywords: ['quotas', 'limits', 'priority', 'scheduling', 'ha'] },
  { id: 'cluster.networking', label: 'Networking', group: 'Cluster', to: '/cluster/networking',
    roles: ['super_admin', 'admin'], keywords: ['calico', 'cni', 'firewall', 'cidr', 'mesh', 'ipv6'] },
  { id: 'cluster.ingress-tls', label: 'Ingress & TLS', group: 'Cluster', to: '/cluster/ingress-tls',
    roles: ['super_admin', 'admin'], keywords: ['certificates', 'acme', 'lets encrypt', 'traefik', 'https', 'ssl'] },
  { id: 'cluster.load-balancer', label: 'Load Balancer', group: 'Cluster', to: '/cluster/load-balancer',
    roles: ['super_admin', 'admin'], keywords: ['lb', 'haproxy', 'vip', 'traffic'] },
  { id: 'cluster.tunnels', label: 'Private Worker Tunnels', group: 'Cluster', to: '/cluster/tunnels',
    roles: ['super_admin', 'admin'], keywords: ['tunnel', 'remote worker', 'connect', 'byo node'] },

  // ─── Platform Settings ─────────────────────────────────────────────────────
  { id: 'platform.updates', label: 'Updates', group: 'Platform Settings', to: '/platform/updates',
    roles: ['super_admin', 'admin'], keywords: ['upgrade', 'version', 'release', 'patch', 'changelog'] },
  { id: 'platform.identity', label: 'Platform Identity', group: 'Platform Settings', to: '/platform/identity',
    roles: ['super_admin', 'admin'], keywords: ['branding', 'name', 'logo', 'apex', 'domain', 'company'] },
  { id: 'platform.plans', label: 'Hosting Plans', group: 'Platform Settings', to: '/platform/plans',
    roles: ['super_admin', 'admin'], keywords: ['pricing', 'tiers', 'packages', 'quotas', 'billing'] },
  { id: 'platform.plesk-migration', label: 'Plesk Migration', group: 'Platform Settings', to: '/platform/plesk-migration',
    roles: ['super_admin'], keywords: ['import', 'migrate', 'onboard', 'cpanel'] },
  { id: 'platform.limits', label: 'Limits & Regional', group: 'Platform Settings', to: '/platform/limits',
    roles: ['super_admin', 'admin'], keywords: ['quota', 'timezone', 'locale', 'region', 'caps'] },
  { id: 'platform.dns', label: 'DNS Providers', group: 'Platform Settings', to: '/platform/dns',
    roles: ['super_admin', 'admin'], keywords: ['powerdns', 'cloudflare', 'route53', 'bind', 'nameservers', 'zones'] },
  { id: 'platform.integrations', label: 'Integrations', group: 'Platform Settings', to: '/platform/integrations',
    roles: ['super_admin', 'admin'], keywords: ['api', 'webhooks', 'external', 'netbird', 'connect'] },
  { id: 'platform.ai', label: 'AI Providers', group: 'Platform Settings', to: '/platform/ai',
    roles: ['super_admin', 'admin'], keywords: ['openai', 'anthropic', 'llm', 'models', 'tokens', 'budget'] },
  { id: 'platform.lifecycle-hooks', label: 'Tenant Lifecycle Hooks', group: 'Platform Settings', to: '/platform/lifecycle-hooks',
    roles: ['super_admin', 'admin'], keywords: ['suspend', 'archive', 'delete', 'automation', 'transitions'] },
  { id: 'platform.notifications.categories', label: 'Notification Sources', group: 'Platform Settings → Notifications', to: '/platform/notifications?tab=categories',
    roles: ['super_admin', 'admin'], keywords: ['events', 'triggers', 'channels', 'rate limit'] },
  { id: 'platform.notifications.providers', label: 'Notification Providers', group: 'Platform Settings → Notifications', to: '/platform/notifications?tab=providers',
    roles: ['super_admin', 'admin'], keywords: ['smtp', 'postmark', 'brevo', 'transport', 'sender'] },
  { id: 'platform.notifications.templates', label: 'Notification Templates', group: 'Platform Settings → Notifications', to: '/platform/notifications?tab=templates',
    roles: ['super_admin', 'admin'], keywords: ['handlebars', 'email body', 'wording', 'locale'] },
  { id: 'platform.notifications.deliveries', label: 'Notification Delivery Log', group: 'Platform Settings → Notifications', to: '/platform/notifications?tab=deliveries',
    roles: ['super_admin', 'admin'], keywords: ['sent', 'failed', 'bounced', 'audit', 'triage'] },
  { id: 'platform.export-import', label: 'Export / Import', group: 'Platform Settings', to: '/platform/export-import',
    roles: ['super_admin'], keywords: ['backup config', 'migrate', 'json', 'dump', 'restore settings'] },

  // ─── Account ───────────────────────────────────────────────────────────────
  { id: 'user-settings', label: 'My Settings', group: 'Account', to: '/user-settings',
    keywords: ['profile', 'password', 'timezone', 'passkey', 'preferences', 'my account'] },
];
