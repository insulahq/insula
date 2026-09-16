import type { RegistryEntry } from './match';

/**
 * Every destination in the tenant panel that global search can reach.
 *
 * Same rationale and same drift risk as the admin registry — see the
 * docblock there. `scripts/ci-search-registry-check.sh` checks both.
 *
 * No `roles` on any entry: unlike the admin panel, the tenant panel
 * gates nothing by role in App.tsx. `tenant_admin` and `tenant_user` see
 * the same pages; the difference between them is which buttons the pages
 * render, which is enforced per-mutation on the backend.
 *
 * Most pages here sit behind `<LifecycleGate>`, which swaps the page for
 * a notice while the account is suspended, archived, or mid storage
 * operation. Search still offers them on purpose: telling the user
 * "Backups" exists and letting the gate explain why it is unavailable is
 * more use than making the entry vanish with no explanation.
 */
export const TENANT_SEARCH_REGISTRY: readonly RegistryEntry[] = [
  { id: 'dashboard', label: 'Dashboard', group: 'Overview', to: '/',
    keywords: ['home', 'start', 'summary', 'overview'] },

  { id: 'domains', label: 'Domains', group: 'Hosting', to: '/domains',
    keywords: ['websites', 'hostnames', 'dns', 'records', 'subdomains', 'ssl', 'routes'] },

  { id: 'applications.installed', label: 'Installed Apps', group: 'Applications', to: '/applications?tab=installed',
    keywords: ['deployments', 'running', 'my apps', 'services'] },
  { id: 'applications.catalog', label: 'Application Catalog', group: 'Applications', to: '/applications?tab=catalog',
    keywords: ['install', 'marketplace', 'templates', 'wordpress', 'nextcloud', 'available'] },
  { id: 'applications.custom', label: 'Custom Containers', group: 'Applications', to: '/applications?tab=custom',
    keywords: ['docker', 'image', 'compose', 'bring your own', 'byoi', 'registry'] },

  { id: 'database-manager', label: 'SQL Manager', group: 'Hosting', to: '/database-manager',
    keywords: ['database', 'mysql', 'mariadb', 'postgres', 'postgresql', 'sqlite', 'phpmyadmin', 'query', 'tables'] },

  { id: 'cron-jobs', label: 'Scheduled Tasks', group: 'Hosting', to: '/cron-jobs',
    keywords: ['cron', 'crontab', 'jobs', 'timers', 'schedule', 'recurring'] },

  { id: 'files', label: 'File Manager', group: 'Hosting', to: '/files',
    keywords: ['ftp', 'upload', 'documents', 'webroot', 'public_html', 'browse', 'editor'] },

  { id: 'snapshots', label: 'Snapshots', group: 'Data', to: '/snapshots',
    keywords: ['restore point', 'volume', 'rollback', 'point in time'] },

  { id: 'email.mailboxes', label: 'Mailboxes', group: 'Email', to: '/email?tab=mailboxes',
    keywords: ['inbox', 'accounts', 'addresses', 'imap', 'smtp', 'webmail', 'quota'] },
  { id: 'email.aliases', label: 'Mailing Lists', group: 'Email', to: '/email?tab=aliases',
    keywords: ['alias', 'forwarding', 'distribution', 'group address'] },
  { id: 'email.settings', label: 'Email Settings & DNS', group: 'Email', to: '/email?tab=settings',
    keywords: ['spf', 'dkim', 'dmarc', 'mx', 'records', 'autodiscover', 'connection'] },

  { id: 'backups', label: 'Backups', group: 'Data', to: '/backups',
    keywords: ['restore', 'download', 'archive', 'bundle', 'export', 'recovery'] },

  { id: 'users', label: 'Users', group: 'Account', to: '/users',
    keywords: ['sub-users', 'team', 'people', 'logins', 'permissions', 'invite'] },

  { id: 'ssh-keys', label: 'SSH Keys', group: 'Access', to: '/ssh-keys',
    keywords: ['public key', 'authorized_keys', 'ed25519', 'rsa', 'fingerprint'] },

  { id: 'sftp', label: 'SFTP Access', group: 'Access', to: '/sftp',
    keywords: ['ftp', 'file transfer', 'credentials', 'upload', 'scp'] },

  { id: 'private-workers', label: 'Private Workers', group: 'Access', to: '/private-workers',
    keywords: ['tunnel', 'remote', 'own server', 'connect', 'token', 'byo node'] },

  { id: 'resource-usage', label: 'Resource Usage', group: 'Account', to: '/resource-usage',
    keywords: ['cpu', 'memory', 'ram', 'storage', 'disk', 'bandwidth', 'quota', 'limits', 'metrics'] },

  { id: 'notifications', label: 'Notifications', group: 'Account', to: '/notifications',
    keywords: ['alerts', 'messages', 'inbox', 'updates'] },
  { id: 'notification-preferences', label: 'Notification Preferences', group: 'Account', to: '/notification-preferences',
    keywords: ['email alerts', 'opt out', 'unsubscribe', 'channels', 'digest'] },

  { id: 'settings', label: 'Settings', group: 'Account', to: '/settings',
    keywords: ['subscription', 'plan', 'billing', 'account', 'auth providers'] },
  { id: 'settings.oidc-providers', label: 'OIDC Providers', group: 'Settings', to: '/settings/oidc-providers',
    keywords: ['sso', 'single sign-on', 'openid', 'login provider', 'idp'] },
  { id: 'settings.mtls-providers', label: 'mTLS Providers', group: 'Settings', to: '/settings/mtls-providers',
    keywords: ['client certificate', 'mutual tls', 'ca', 'pki'] },
  { id: 'settings.openziti-providers', label: 'OpenZiti Providers', group: 'Settings', to: '/settings/openziti-providers',
    keywords: ['zero trust', 'ziti', 'overlay', 'tunnel'] },
  { id: 'settings.zrok-providers', label: 'zrok Providers', group: 'Settings', to: '/settings/zrok-providers',
    keywords: ['share', 'tunnel', 'public url', 'expose'] },

  { id: 'user-settings', label: 'My Settings', group: 'Account', to: '/user-settings',
    keywords: ['profile', 'password', 'timezone', 'passkey', 'preferences', 'my account'] },
];
