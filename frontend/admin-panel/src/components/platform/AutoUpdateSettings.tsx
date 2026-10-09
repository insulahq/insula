import { useMemo, useState, type ReactElement } from 'react';
import { Clock, CheckCircle, AlertTriangle, Loader2, PauseCircle } from 'lucide-react';
import type { AutoUpdateStatus, MaintenanceWindow } from '@insula/api-contracts';
import { useUpdateSettings, type PlatformVersionData } from '@/hooks/use-platform-updates';

/**
 * ADR-064 §7 — automatic updates and their maintenance window. They apply a
 * verified STABLE, non-BREAKING release through the same run and pre-flight as a
 * manual upgrade, and only inside the window; without a window they never act.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const STATUS_ICON: Record<AutoUpdateStatus['state'], ReactElement> = {
  off: <PauseCircle size={13} className="text-gray-400" />,
  current: <CheckCircle size={13} className="text-green-600 dark:text-green-400" />,
  held: <PauseCircle size={13} className="text-amber-500" />,
  'waiting-window': <Clock size={13} className="text-blue-500" />,
  blocked: <AlertTriangle size={13} className="text-amber-500" />,
  running: <Loader2 size={13} className="animate-spin text-blue-500" />,
  started: <Loader2 size={13} className="animate-spin text-blue-500" />,
};

function defaultWindow(): MaintenanceWindow {
  let timeZone = 'UTC';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  return { days: [0], start: '02:00', end: '05:00', timeZone };
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];
  } catch {
    return ['UTC'];
  }
}

export default function AutoUpdateSettings({ v, canEdit }: { readonly v: PlatformVersionData; readonly canEdit: boolean }) {
  const updateSettings = useUpdateSettings();
  const [autoLocal, setAutoLocal] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<MaintenanceWindow | null>(null);
  const enabled = autoLocal ?? v.autoUpdate;
  const saved = v.maintenanceWindow ?? null;
  const w = draft ?? saved ?? defaultWindow();
  const dirty = draft !== null;
  const tzList = useMemo(zones, []);
  const error = updateSettings.error as Error | null;

  const toggle = (on: boolean) => {
    setAutoLocal(on);
    updateSettings.mutate({ autoUpdate: on });
  };
  const save = () => updateSettings.mutate(
    { autoUpdate: enabled, maintenanceWindow: w },
    { onSuccess: () => setDraft(null) },
  );
  const edit = (patch: Partial<MaintenanceWindow>) => setDraft({ ...w, ...patch });
  const toggleDay = (d: number) => edit({ days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort() });
  const status = v.autoUpdateStatus;

  return (
    <div className="w-full space-y-2" data-testid="auto-update-settings">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox" data-testid="auto-update-toggle" checked={enabled} disabled={!canEdit}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-60 dark:border-gray-600"
        />
        Automatic updates
      </label>
      {enabled && (
        <div className="space-y-2 rounded-md border border-gray-200 p-3 text-xs dark:border-gray-700">
          <p className="text-gray-600 dark:text-gray-300">
            Applies a verified stable release inside the maintenance window, through the same checks and steps as a manual
            upgrade. Never a release candidate or a BREAKING release. A failing check skips the window and notifies.
          </p>
          <div className="flex flex-wrap items-center gap-2" data-testid="maintenance-window">
            <span className="font-medium text-gray-700 dark:text-gray-200">Maintenance window</span>
            {DAYS.map((name, d) => (
              <button
                key={name} type="button" disabled={!canEdit} onClick={() => toggleDay(d)}
                data-testid={`window-day-${d}`} aria-pressed={w.days.includes(d)}
                className={`rounded px-1.5 py-0.5 ${w.days.includes(d)
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'} disabled:opacity-60`}
              >
                {name}
              </button>
            ))}
            <input type="time" value={w.start} disabled={!canEdit} onChange={(e) => edit({ start: e.target.value })} data-testid="window-start"
              className="rounded border border-gray-300 px-1 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            <span className="text-gray-500 dark:text-gray-400">to</span>
            <input type="time" value={w.end} disabled={!canEdit} onChange={(e) => edit({ end: e.target.value })} data-testid="window-end"
              className="rounded border border-gray-300 px-1 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            <input list="tz-list" value={w.timeZone} disabled={!canEdit} onChange={(e) => edit({ timeZone: e.target.value })} data-testid="window-tz"
              className="w-44 rounded border border-gray-300 px-1 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            <datalist id="tz-list">{tzList.map((z) => <option key={z} value={z} />)}</datalist>
            {canEdit && (dirty || !saved) && (
              <button type="button" onClick={save} disabled={updateSettings.isPending || w.days.length === 0} data-testid="window-save"
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700 disabled:opacity-50">
                {updateSettings.isPending && <Loader2 size={12} className="animate-spin" />} Save window
              </button>
            )}
          </div>
          {!saved && !dirty && (
            <p className="text-amber-700 dark:text-amber-300" data-testid="window-missing">No window saved yet — automatic updates do nothing until one is.</p>
          )}
          {error && <p className="text-red-700 dark:text-red-400">{error.message}</p>}
        </div>
      )}
      {status && (
        <p className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300" data-testid="auto-update-status">
          {STATUS_ICON[status.state]} {status.detail}
          <span className="text-gray-400 dark:text-gray-500">· checked {new Date(status.checkedAt).toLocaleTimeString()}</span>
        </p>
      )}
    </div>
  );
}
