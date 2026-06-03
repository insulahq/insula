import { useState } from 'react';
import { Loader2, RefreshCw, CheckCircle, AlertTriangle, XCircle, ArrowRight, ShieldAlert } from 'lucide-react';
import { usePlatformVersion } from '@/hooks/use-platform-updates';
import { usePreflight, useUpgradeApply, useRollback, type UpgradeGate, type UpgradeApplyData, type RollbackData } from '@/hooks/use-platform-upgrade';

/**
 * Platform → Upgrades (super_admin) — ADR-045 W14. Shows the version spine
 * (installed → available), the live pre-flight gates, and a guarded
 * preview → apply flow that re-pins the cluster's Flux source to a release tag.
 * The actual re-pin is server-side gated on pre-flight passing.
 */
function GateRow({ gate }: { gate: UpgradeGate }) {
  const icon =
    gate.status === 'pass' ? <CheckCircle className="h-4 w-4 text-green-600" /> :
    gate.status === 'warn' ? <AlertTriangle className="h-4 w-4 text-amber-500" /> :
    <XCircle className="h-4 w-4 text-red-600" />;
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900">{gate.label}</div>
        <div className="text-xs text-gray-500">{gate.detail}</div>
      </div>
    </div>
  );
}

export default function UpgradesPage() {
  const { data: versionRes, isLoading: versionLoading } = usePlatformVersion();
  const preflight = usePreflight();
  const apply = useUpgradeApply();
  const rollback = useRollback();
  const [version, setVersion] = useState('');
  const [preview, setPreview] = useState<UpgradeApplyData | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rbPreview, setRbPreview] = useState<RollbackData | null>(null);
  const [rbConfirming, setRbConfirming] = useState(false);
  const [restoreData, setRestoreData] = useState(false);

  const v = versionRes?.data;
  const pf = preflight.data?.data;
  const isProduction = (v?.environment ?? '') === 'production';

  const onPreview = async () => {
    setConfirming(false);
    const res = await apply.mutateAsync({ version: version.trim() || undefined, apply: false });
    setPreview(res.data);
  };
  const onApply = async () => {
    const res = await apply.mutateAsync({ version: version.trim() || undefined, apply: true });
    setPreview(res.data);
    setConfirming(false);
  };

  const applyError = apply.error as Error | null;
  const rbError = rollback.error as Error | null;

  const onRbPreview = async () => {
    setRbConfirming(false);
    const res = await rollback.mutateAsync({ apply: false, restoreData });
    setRbPreview(res.data);
  };
  const onRbApply = async () => {
    const res = await rollback.mutateAsync({ apply: true, restoreData });
    setRbPreview(res.data);
    setRbConfirming(false);
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Platform Upgrades</h1>
        <p className="text-sm text-gray-500 mt-1">
          Re-pin the cluster to a verified release. {isProduction ? 'Production — manual, gated.' : 'Non-production environments auto-follow their branch.'}
        </p>
      </div>

      {/* Version spine */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        {versionLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        ) : (
          <div className="flex items-center gap-4">
            <div>
              <div className="text-xs text-gray-500">Installed</div>
              <div className="text-lg font-mono font-semibold text-gray-900">{v?.currentVersion ?? 'unknown'}</div>
            </div>
            <ArrowRight className="h-5 w-5 text-gray-300" />
            <div>
              <div className="text-xs text-gray-500">Available</div>
              <div className="text-lg font-mono font-semibold text-gray-900">{v?.latestVersion ?? '—'}</div>
            </div>
            <span className="ml-auto text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600">{v?.environment}</span>
            {v?.updateAvailable && <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700">update available</span>}
          </div>
        )}
      </div>

      {/* Pre-flight */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Pre-flight checks</h2>
          <button onClick={() => preflight.refetch()} className="text-xs text-gray-500 hover:text-gray-900 flex items-center gap-1">
            <RefreshCw className={`h-3 w-3 ${preflight.isFetching ? 'animate-spin' : ''}`} /> refresh
          </button>
        </div>
        {preflight.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        ) : pf ? (
          <>
            {pf.gates.map((g) => <GateRow key={g.id} gate={g} />)}
            <div className="mt-3 text-xs">
              {pf.ok
                ? <span className="text-green-700">All blocking checks pass{pf.warnings ? ` (${pf.warnings} warning${pf.warnings > 1 ? 's' : ''})` : ''}.</span>
                : <span className="text-red-700 font-medium">{pf.failures} blocking failure(s) — resolve before upgrading.</span>}
            </div>
          </>
        ) : (
          <div className="text-xs text-red-600">Could not load pre-flight checks.</div>
        )}
      </div>

      {/* Upgrade action */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Run upgrade</h2>
        <div className="flex items-center gap-2">
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder={v?.latestVersion ?? 'version (e.g. 2026.7.0)'}
            className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 font-mono"
          />
          <button
            onClick={onPreview}
            disabled={apply.isPending}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {apply.isPending && !confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview'}
          </button>
        </div>

        {preview && (
          <div className="text-xs rounded border border-gray-200 bg-gray-50 p-3 space-y-1">
            <div><span className="text-gray-500">decision:</span> <span className="font-mono">{preview.action}</span>{preview.target ? ` → ${preview.target}` : ''}</div>
            <div className="text-gray-600">{preview.summary}</div>
            {preview.applied && <div className="text-green-700 font-medium">Applied — Flux is reconciling.</div>}
          </div>
        )}

        {applyError && (
          <div className="text-xs text-red-700 flex items-start gap-1">
            <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{applyError.message}</span>
          </div>
        )}

        {/* Apply is two-click + requires pre-flight ok */}
        {preview?.proceed && !preview.applied && (
          confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-700 font-medium">Re-pin the cluster to {preview.target}? This rolls every workload.</span>
              <button onClick={onApply} disabled={apply.isPending} className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm upgrade'}
              </button>
              <button onClick={() => setConfirming(false)} className="text-xs text-gray-500">cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={!pf?.ok}
              title={!pf?.ok ? 'Pre-flight has blocking failures' : ''}
              className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Apply upgrade →
            </button>
          )
        )}
      </div>

      {/* Rollback */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Roll back the last upgrade</h2>
        <p className="text-xs text-gray-500">
          Re-pins the Flux source back to the ref recorded before the last upgrade. A rescue snapshot is taken before every upgrade.
        </p>
        <div className="flex items-center gap-3">
          <button onClick={onRbPreview} disabled={rollback.isPending} className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {rollback.isPending && !rbConfirming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview rollback'}
          </button>
          <label className="text-xs text-gray-600 flex items-center gap-1">
            <input type="checkbox" checked={restoreData} onChange={(e) => setRestoreData(e.target.checked)} />
            also restore data (revert volumes — destructive)
          </label>
        </div>

        {rbPreview && (
          <div className="text-xs rounded border border-gray-200 bg-gray-50 p-3 space-y-1">
            <div className="text-gray-600">{rbPreview.summary}</div>
            {rbPreview.manifest && <div className="text-gray-500">target was {rbPreview.manifest.toVersion}, {rbPreview.manifest.rescueSnapshots} rescue snapshot(s)</div>}
          </div>
        )}
        {rbError && (
          <div className="text-xs text-red-700 flex items-start gap-1">
            <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>{rbError.message}</span>
          </div>
        )}

        {rbPreview?.ok && !rbPreview.dataRestored && rbPreview.manifest && (
          rbConfirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-700 font-medium">Roll back to {JSON.stringify(rbPreview.manifest.previousRef)}{restoreData ? ' AND revert volumes (DESTRUCTIVE)' : ''}?</span>
              <button onClick={onRbApply} disabled={rollback.isPending} className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {rollback.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm rollback'}
              </button>
              <button onClick={() => setRbConfirming(false)} className="text-xs text-gray-500">cancel</button>
            </div>
          ) : (
            <button onClick={() => setRbConfirming(true)} className="text-sm px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700">
              Roll back →
            </button>
          )
        )}
      </div>
    </div>
  );
}
