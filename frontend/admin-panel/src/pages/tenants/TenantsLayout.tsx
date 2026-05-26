import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';
import { Users, Globe, Boxes, UserCircle, Mail, Clock } from 'lucide-react';

interface TabDef {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Users;
}

const TABS: readonly TabDef[] = [
  { to: '/tenants/list', label: 'Tenants', icon: Users },
  { to: '/tenants/domains', label: 'Domains', icon: Globe },
  { to: '/tenants/workloads', label: 'Workloads', icon: Boxes },
  { to: '/tenants/users', label: 'Users', icon: UserCircle },
  { to: '/tenants/email-accounts', label: 'Email Accounts', icon: Mail },
  { to: '/tenants/cron-jobs', label: 'Cron Jobs', icon: Clock },
];

export default function TenantsLayout() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Tenants</h1>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex flex-wrap gap-x-6" aria-label="Tenants tabs">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                clsx(
                  'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200',
                )
              }
              data-testid={`tenants-tab-${tab.label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <tab.icon size={14} />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}
