import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Globe,
  AppWindow,
  Database,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Network,
  UserCog,
  Activity,
  ScrollText,
  Server,
  Settings,
  KeyRound,
  Package,
  Mail,
  Cloud,
  LifeBuoy,
  HardDrive,
  SlidersHorizontal,
  Cable,
  Cpu,
  Download,
  Building2,
  CreditCard,
  Workflow,
  Link2,
  Gauge,
  Upload,
  ChevronDown,
  ChevronRight,
  X,
  AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { useRuntimeInfo } from '@/hooks/use-runtime-info';

/** Compact identity block under the sidebar title — version, branch,
 *  and the node name of the platform-api pod that's serving us. Hidden
 *  until the fetch completes; null fields render as "—". */
function RuntimeInfoBlock() {
  const info = useRuntimeInfo();
  if (!info) return null;
  return (
    <div className="px-5 pb-3 text-[10px] uppercase tracking-wide text-white/60" data-testid="sidebar-runtime-info">
      <div className="font-mono normal-case text-[11px] tracking-normal text-white/80" title="Running version">
        {info.version}
      </div>
      <div className="flex gap-2 normal-case tracking-normal">
        {info.branch && <span title="Build branch">{info.branch}</span>}
        {info.node && <span title="Serving node">· {info.node}</span>}
      </div>
    </div>
  );
}

interface SimpleNavItem {
  readonly kind: 'item';
  readonly to: string;
  readonly icon: typeof LayoutDashboard;
  readonly label: string;
  /** When true, the link is "active" only on exact pathname match. Use
   *  for prefix-of-other-children paths like `/backups` when siblings
   *  live at `/backups/system`, otherwise NavLink's default prefix
   *  match lights up both rows simultaneously. */
  readonly exact?: boolean;
}
interface GroupNavItem {
  readonly kind: 'group';
  readonly id: string;
  readonly icon: typeof LayoutDashboard;
  readonly label: string;
  readonly children: ReadonlyArray<SimpleNavItem>;
}
type NavItem = SimpleNavItem | GroupNavItem;

/** A child is "active" for the purpose of group expansion when either
 *  the pathname matches exactly (for entries marked `exact`) or is a
 *  prefix-match (default React Router behaviour). Mirrors the rule
 *  used by NavLink's `end` prop so the active CSS state and the group
 *  expansion stay in lockstep. */
function isChildMatch(child: SimpleNavItem, pathname: string): boolean {
  return child.exact === true ? pathname === child.to : pathname.startsWith(child.to);
}

const navItems: ReadonlyArray<NavItem> = [
  { kind: 'item',  to: '/',                       icon: LayoutDashboard, label: 'Dashboard' },
  { kind: 'item',  to: '/tenants',                icon: Users,           label: 'Tenants' },
  { kind: 'item',  to: '/applications',           icon: AppWindow,       label: 'Applications' },
  {
    kind: 'group',
    id: 'backups',
    icon: Database,
    label: 'Backups',
    children: [
      { kind: 'item', to: '/backups',                      icon: LayoutDashboard, label: 'Dashboard', exact: true },
      { kind: 'item', to: '/backups/system',               icon: KeyRound,        label: 'System' },
      { kind: 'item', to: '/backups/tenants',              icon: Package,         label: 'Tenants' },
      { kind: 'item', to: '/backups/mail',                 icon: Mail,            label: 'Mail' },
      { kind: 'item', to: '/backups/targets',              icon: Cloud,           label: 'Remote Storage Targets' },
      { kind: 'item', to: '/backups/disaster-recovery',    icon: LifeBuoy,        label: 'Disaster Recovery' },
    ],
  },
  {
    kind: 'group',
    id: 'email',
    icon: Mail,
    label: 'Email',
    children: [
      { kind: 'item', to: '/email/domains',    icon: Globe,         label: 'Domains & Relays' },
      { kind: 'item', to: '/email/settings',   icon: Settings,      label: 'Settings' },
      { kind: 'item', to: '/email/operations', icon: Server,        label: 'Operations' },
      { kind: 'item', to: '/email/drift',      icon: AlertTriangle, label: 'Data Drift' },
    ],
  },
  {
    kind: 'group',
    id: 'security',
    icon: Shield,
    label: 'Security',
    children: [
      { kind: 'item', to: '/security/posture',        icon: ShieldCheck, label: 'Posture' },
      { kind: 'item', to: '/security/network-trust',  icon: Network,     label: 'Network Trust' },
      { kind: 'item', to: '/security/identity',       icon: UserCog,     label: 'Identity & Sessions' },
      { kind: 'item', to: '/security/web-defense',    icon: ShieldAlert, label: 'Web Defense' },
      { kind: 'item', to: '/security/oidc',           icon: KeyRound,    label: 'OIDC / SSO' },
    ],
  },
  { kind: 'item',  to: '/monitoring',             icon: Activity,        label: 'Monitoring' },
  { kind: 'item',  to: '/monitoring/audit-logs',  icon: ScrollText,      label: 'Audit Logs' },
  {
    kind: 'group',
    id: 'cluster',
    icon: Server,
    label: 'Cluster',
    children: [
      { kind: 'item', to: '/cluster/nodes',             icon: Server,             label: 'Nodes' },
      { kind: 'item', to: '/cluster/storage',           icon: HardDrive,          label: 'Storage' },
      { kind: 'item', to: '/cluster/cluster-policies',  icon: SlidersHorizontal,  label: 'Cluster Policies' },
      { kind: 'item', to: '/cluster/networking',        icon: Network,            label: 'Networking' },
      { kind: 'item', to: '/cluster/ingress-tls',       icon: Globe,              label: 'Ingress & TLS' },
      { kind: 'item', to: '/cluster/load-balancer',     icon: Cable,              label: 'Load Balancer' },
      { kind: 'item', to: '/cluster/tunnels',           icon: Link2,              label: 'Private Worker Tunnels' },
    ],
  },
  {
    kind: 'group',
    id: 'platform',
    icon: Settings,
    label: 'Platform Settings',
    children: [
      { kind: 'item', to: '/platform/updates',          icon: Download,           label: 'Updates' },
      { kind: 'item', to: '/platform/identity',         icon: Building2,          label: 'Identity' },
      { kind: 'item', to: '/platform/plans',            icon: CreditCard,         label: 'Hosting Plans' },
      { kind: 'item', to: '/platform/limits',           icon: Gauge,              label: 'Limits & Regional' },
      { kind: 'item', to: '/platform/dns',              icon: Globe,              label: 'DNS Providers' },
      { kind: 'item', to: '/platform/integrations',     icon: Link2,              label: 'Integrations' },
      { kind: 'item', to: '/platform/ai',               icon: Cpu,                label: 'AI Providers' },
      { kind: 'item', to: '/platform/lifecycle-hooks',  icon: Workflow,           label: 'Tenant Lifecycle Hooks' },
      { kind: 'item', to: '/platform/export-import',    icon: Upload,             label: 'Export / Import' },
    ],
  },
];

interface SidebarProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const location = useLocation();

  // Auto-expand any group whose child route is currently active so
  // the user lands on a visible nav item after a deep-link. Using a
  // function initializer so the Set is built once on mount, not on
  // every re-render.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const item of navItems) {
      if (item.kind === 'group' && item.children.some((c) => isChildMatch(c, location.pathname))) {
        init.add(item.id);
      }
    }
    return init;
  });

  // Auto-expand on client-side navigation (NavLink keeps Sidebar
  // mounted, so initialExpanded only fires once on first render).
  // Merges into existing state so operator-collapsed groups don't
  // pop back open unless their child route is the new pathname.
  useEffect(() => {
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const item of navItems) {
        if (item.kind !== 'group') continue;
        if (item.children.some((c) => isChildMatch(c, location.pathname)) && !next.has(item.id)) {
          next.add(item.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [location.pathname]);

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onClose}
          data-testid="sidebar-overlay"
        />
      )}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-linear-to-b from-brand-500 to-accent-500 transition-transform duration-200 lg:static lg:translate-x-0 dark:from-brand-900 dark:to-accent-700',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        data-testid="sidebar"
      >
        <div className="flex h-16 items-center justify-between px-5">
          <span className="text-lg font-bold text-white">K8s Hosting</span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-white/80 hover:text-white lg:hidden"
            aria-label="Close sidebar"
          >
            <X size={20} />
          </button>
        </div>

        <RuntimeInfoBlock />

        <nav className="flex-1 space-y-1 px-3 py-4" role="navigation" aria-label="Main">
          {navItems.map((item) => {
            if (item.kind === 'item') {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/' || item.exact === true}
                  onClick={onClose}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-white/20 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white',
                    )
                  }
                >
                  <Icon size={18} />
                  {item.label}
                </NavLink>
              );
            }
            // Group
            const GroupIcon = item.icon;
            const isExpanded = expanded.has(item.id);
            const childActive = item.children.some((c) => isChildMatch(c, location.pathname));
            return (
              <div key={item.id} data-testid={`sidebar-group-${item.id}`}>
                <button
                  type="button"
                  onClick={() => toggleGroup(item.id)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    childActive
                      ? 'bg-white/15 text-white'
                      : 'text-white/70 hover:bg-white/10 hover:text-white',
                  )}
                  aria-expanded={isExpanded}
                >
                  <GroupIcon size={18} />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isExpanded
                    ? <ChevronDown size={14} className="text-white/50" />
                    : <ChevronRight size={14} className="text-white/50" />}
                </button>
                {isExpanded && (
                  <div className="ml-3 mt-1 space-y-1 border-l border-white/20 pl-2">
                    {item.children.map((c) => {
                      const ChildIcon = c.icon;
                      return (
                        <NavLink
                          key={c.to}
                          to={c.to}
                          end={c.exact === true}
                          onClick={onClose}
                          className={({ isActive }) =>
                            clsx(
                              'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                              isActive
                                ? 'bg-white/20 text-white'
                                : 'text-white/60 hover:bg-white/10 hover:text-white',
                            )
                          }
                        >
                          <ChildIcon size={14} />
                          {c.label}
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
