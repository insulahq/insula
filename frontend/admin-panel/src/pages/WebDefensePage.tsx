/**
 * Web Defense — Security Hub → Web Defense.
 *
 * Owns the CrowdSec + ModSecurity / WAF operator surfaces.
 *
 * Layout: 4 tabs
 *   - WAF Events     — cluster-wide ModSec/CRS event stream
 *   - Banned IPs     — active CrowdSec bans + static blocklist
 *   - WAF Exclusions — per-route CRS rule exclusions + IP allowlist
 *   - WAF Settings   — CrowdSec status, Console enrollment, auto-ban
 *                     calibration, L4 host-firewall enforcement toggle
 *
 * Tab bodies are imported from
 * `components/security/web-defense-tabs.tsx` — that's where the
 * extracted CrowdSec + WAF render code lives. This page is just the
 * shell.
 *
 * History note (2026-05-26): the L4 banner used to sit above the tabs
 * because it has cluster-wide blast radius. The same toggle is also
 * surfaced inside the Banned IPs tab. Keeping both was a UX bug —
 * operators saw the same control twice. Banner removed; the L4 card
 * is the canonical surface and now lives in the WAF Settings tab next
 * to the rest of the CrowdSec configuration.
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import {
  BannedIpsTab,
  WafEventsTab,
  WafExclusionsTab,
  WafSettingsTab,
} from '@/components/security/web-defense-tabs';

type TabId = 'waf' | 'bans' | 'exclusions' | 'settings';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly hint: string }> = [
  { id: 'waf', label: 'WAF Events', hint: 'Cluster-wide ModSec/CRS event stream' },
  { id: 'bans', label: 'Banned IPs', hint: 'CrowdSec ban decisions + static blocklist' },
  { id: 'exclusions', label: 'WAF Exclusions', hint: 'Per-route CRS rule exclusions + IP allowlist' },
  { id: 'settings', label: 'WAF Settings', hint: 'CrowdSec status, auto-ban, L4 enforcement' },
];

const VALID_TABS: ReadonlySet<TabId> = new Set(['waf', 'bans', 'exclusions', 'settings']);

export default function WebDefensePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: TabId = useMemo(() => {
    if (requested && VALID_TABS.has(requested as TabId)) return requested as TabId;
    return 'waf';
  }, [requested]);
  const setActiveTab = (id: TabId): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <ShieldAlert size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Web Defense</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
          ModSecurity CRS events, CrowdSec ban decisions, per-route WAF rule exclusions,
          and the cluster-wide CrowdSec configuration (auto-ban tuning, L4 host-firewall
          enforcement). The L4 enforcement toggle lives in <strong>WAF Settings</strong> —
          read the operator-IP-trust check before flipping to <code>enforce</code>.
        </p>
      </header>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist">
        {TABS.map(({ id, label, hint }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`web-defense-panel-${id}`}
              id={`web-defense-tab-${id}`}
              data-testid={`tab-${id}`}
              title={hint}
              onClick={() => setActiveTab(id)}
              className={clsx(
                '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      <div
        role="tabpanel"
        id={`web-defense-panel-${activeTab}`}
        aria-labelledby={`web-defense-tab-${activeTab}`}
      >
        {activeTab === 'waf' && <WafEventsTab />}
        {activeTab === 'bans' && <BannedIpsTab />}
        {activeTab === 'exclusions' && <WafExclusionsTab />}
        {activeTab === 'settings' && <WafSettingsTab />}
      </div>
    </div>
  );
}
