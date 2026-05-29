/**
 * `<BackupClassPage>` — the shared tab shell used by
 * `/backups/system`, `/backups/tenants`, and `/backups/mail`.
 *
 * Honesty/B0 (2026-05-22): not every class has both snapshots AND
 * backups. Mail has only off-site restic backups — no in-cluster
 * snapshot — so its Snapshots tab is suppressed. Callers pass
 * `snapshotsTab={null}` or omit the prop to opt out.
 *
 * Tabs:
 *   (a) Snapshots — point-in-time, in-cluster CSI block copies.
 *       Optional. If `snapshotsTab` is null/absent, the tab + its
 *       URL state are not rendered at all.
 *   (b) Backups — uploaded artifacts at the off-cluster target.
 *       Optional. If `backupsTab` is null/absent, suppressed.
 *   (c) Targets, Schedules & Retention — always rendered.
 */

import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, Cloud, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { BackupShimClass } from '@insula/api-contracts';
import BackupRoutingTab from './BackupRoutingTab';

type TabId = 'snapshots' | 'backups' | 'routing';

interface TabSpec {
  readonly id: TabId;
  readonly label: string;
  readonly icon: LucideIcon;
}

const SNAPSHOTS_TAB: TabSpec = { id: 'snapshots', label: 'Snapshots', icon: HardDrive };
const BACKUPS_TAB: TabSpec = { id: 'backups',   label: 'Backups',   icon: Archive };
const ROUTING_TAB: TabSpec = { id: 'routing',   label: 'Targets, Schedules & Retention', icon: Cloud };

export interface BackupClassPageProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly subtitle: string;
  readonly shimClass: BackupShimClass;
  readonly scheduleSubsystems: ReadonlyArray<string>;
  /** Tab (a) content. Pass `null` (or omit) to suppress the tab. */
  readonly snapshotsTab?: ReactNode | null;
  /** Tab (b) content. Pass `null` (or omit) to suppress the tab. */
  readonly backupsTab?: ReactNode | null;
  readonly testIdPrefix?: string;
}

export default function BackupClassPage(props: BackupClassPageProps) {
  const [params, setParams] = useSearchParams();
  const testId = props.testIdPrefix ?? `backups-${props.shimClass}`;
  const HeaderIcon = props.icon;

  // Build the active tab list based on which content the caller
  // provided. Routing is always present; snapshots/backups are only
  // present when the caller has real content to render.
  const tabs: ReadonlyArray<TabSpec> = [
    ...(props.snapshotsTab != null ? [SNAPSHOTS_TAB] : []),
    ...(props.backupsTab != null ? [BACKUPS_TAB] : []),
    ROUTING_TAB,
  ];

  const raw = params.get('tab');
  const fallback: TabId = tabs[0]?.id ?? 'routing';
  const tab: TabId = tabs.some((t) => t.id === raw) ? (raw as TabId) : fallback;

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
          {tabs.map((t) => {
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
