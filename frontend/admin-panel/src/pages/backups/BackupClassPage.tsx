/**
 * `<BackupClassPage>` — the shared 3-tab shell used by
 * `/backups/system`, `/backups/tenants`, and `/backups/mail`.
 *
 * Phase 3 (2026-05-22) lands the canonical IA agreed with the
 * operator: every backup class has exactly three tabs:
 *
 *   (a) Snapshots — point-in-time, in-cluster block copies
 *   (b) Backups   — uploaded artifacts at the off-cluster
 *                   Remote Storage Target
 *   (c) Targets, Schedules & Retention — binding + cron + retention
 *
 * The class-specific content for (a) and (b) is passed in as
 * `snapshotsTab` / `backupsTab` props. Tab (c) is rendered by the
 * shared `<BackupRoutingTab>` and only needs the shim class name.
 *
 * Tab selection persists in `?tab=…` so deep-links work.
 */

import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, Cloud, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { BackupShimClass } from '@k8s-hosting/api-contracts';
import BackupRoutingTab from './BackupRoutingTab';

type Tab = 'snapshots' | 'backups' | 'routing';

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'snapshots', label: 'Snapshots',                         icon: HardDrive },
  { id: 'backups',   label: 'Backups',                           icon: Archive },
  { id: 'routing',   label: 'Targets, Schedules & Retention',    icon: Cloud },
];

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v);
}

export interface BackupClassPageProps {
  /** Header icon (lifted to caller so each class can pick its own). */
  readonly icon: LucideIcon;
  /** Display name of the class — "System Backups", "Tenant Backups", etc. */
  readonly title: string;
  /** One-line subtitle under the header explaining what this class covers. */
  readonly subtitle: string;
  /** R-X shim class name. Drives tab (c)'s assignments + schedule lookup. */
  readonly shimClass: BackupShimClass;
  /** `backup_schedules.subsystem` rows to surface on tab (c). Empty array
   *  hides the Schedules section (e.g. classes with no cron-driven flow). */
  readonly scheduleSubsystems: ReadonlyArray<string>;
  /** Tab (a) content — class-specific snapshot list. */
  readonly snapshotsTab: ReactNode;
  /** Tab (b) content — class-specific backup list. */
  readonly backupsTab: ReactNode;
  /** Optional `data-testid` prefix. Default derives from shim class. */
  readonly testIdPrefix?: string;
}

export default function BackupClassPage(props: BackupClassPageProps) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = isTab(raw) ? raw : 'snapshots';
  const testId = props.testIdPrefix ?? `backups-${props.shimClass}`;
  const HeaderIcon = props.icon;

  return (
    <div className="space-y-6 p-6" data-testid={`${testId}-page`}>
      <header className="flex items-start gap-3">
        <HeaderIcon size={24} className="mt-0.5 text-gray-700 dark:text-gray-300" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{props.title}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{props.subtitle}</p>
        </div>
      </header>

      <div
        role="tablist"
        aria-label={`${props.title} sub-tabs`}
        className="border-b border-gray-200 dark:border-gray-700"
      >
        <div className="-mb-px flex flex-wrap gap-x-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`${testId}-pane-${t.id}`}
                id={`${testId}-tab-${t.id}-btn`}
                onClick={() =>
                  // Spread-merge: preserve any other query params (a
                  // future Restoration Wizard row-highlight param,
                  // for example) when flipping tabs.
                  setParams(
                    (prev) => {
                      prev.set('tab', t.id);
                      return prev;
                    },
                    { replace: true },
                  )
                }
                data-testid={`${testId}-tab-${t.id}`}
                className={clsx(
                  'flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand-500 text-brand-600 dark:text-brand-300'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
                )}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${testId}-pane-${tab}`}
        aria-labelledby={`${testId}-tab-${tab}-btn`}
        data-testid={`${testId}-pane-${tab}`}
      >
        {tab === 'snapshots' && props.snapshotsTab}
        {tab === 'backups' && props.backupsTab}
        {tab === 'routing' && (
          <BackupRoutingTab
            shimClass={props.shimClass}
            scheduleSubsystems={props.scheduleSubsystems}
          />
        )}
      </div>
    </div>
  );
}
