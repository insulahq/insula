import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Network,
  Save,
  ShieldCheck,
  ShieldAlert,
  Info,
} from 'lucide-react';
import type { ClusterIssuerSummary } from '@k8s-hosting/api-contracts';
import {
  usePrivateWorkerTunnelSettings,
  usePrivateWorkerTunnelStatus,
  useUpdatePrivateWorkerTunnelIssuer,
} from '@/hooks/use-private-worker-tunnel';

const inputClass =
  'w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 px-3 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const ISSUER_TYPE_LABEL: Record<ClusterIssuerSummary['type'], string> = {
  http01: 'HTTP-01',
  dns01: 'DNS-01',
  unknown: 'unknown',
};

const REFERENCE_ISSUER_SNIPPET = `kubectl apply -f https://raw.githubusercontent.com/cert-manager/cert-manager/master/deploy/charts/cert-manager/templates/cluster-issuer.yaml
# or apply your own cluster-issuers.reference.yaml`;

export default function PrivateWorkerTunnelSettings() {
  const settingsQuery = usePrivateWorkerTunnelSettings();
  const statusQuery = usePrivateWorkerTunnelStatus();
  const updateIssuer = useUpdatePrivateWorkerTunnelIssuer();

  const settings = settingsQuery.data?.data;
  const status = statusQuery.data?.data;

  const [selectedIssuer, setSelectedIssuer] = useState<string>('');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings && !selectedIssuer) {
      setSelectedIssuer(settings.issuer);
    }
  }, [settings, selectedIssuer]);

  const currentIssuer = status?.currentIssuer ?? settings?.issuer ?? '';
  const dirty = selectedIssuer !== '' && selectedIssuer !== currentIssuer;

  const handleSave = () => {
    if (!dirty) return;
    setSavedMessage(null);
    setSaveError(null);
    updateIssuer.mutate(
      { issuer: selectedIssuer },
      {
        onSuccess: () => {
          setSavedMessage(
            'Issuer updated. New worker certs will use it; existing certs continue with their previous issuer until renewal.',
          );
          setTimeout(() => setSavedMessage(null), 8_000);
        },
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to update issuer');
          setTimeout(() => setSaveError(null), 8_000);
        },
      },
    );
  };

  const isLoading = settingsQuery.isLoading || statusQuery.isLoading;
  const loadError = settingsQuery.error ?? statusQuery.error;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Network size={28} className="text-brand-500" />
        <div>
          <h1
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
            data-testid="private-worker-tunnel-heading"
          >
            Private Worker Tunnels
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-3xl">
            Each private worker gets its own LE-issued cert under{' '}
            <code className="text-gray-700 dark:text-gray-300">tunnels.&#36;{'{DOMAIN}'}</code>. Default issuer
            uses HTTP-01 (no DNS API needed). Switch to a DNS-01 issuer for one wildcard cert at scale.
          </p>
        </div>
      </div>

      {isLoading && (
        <div
          className="flex items-center gap-2 py-8"
          data-testid="private-worker-tunnel-loading"
        >
          <Loader2 size={20} className="animate-spin text-brand-500" />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Loading tunnel settings…
          </span>
        </div>
      )}

      {loadError && !isLoading && (
        <div
          className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400"
          data-testid="private-worker-tunnel-error"
        >
          <AlertCircle size={16} />
          <span>
            Failed to load tunnel settings:{' '}
            {loadError instanceof Error ? loadError.message : 'Unknown error'}
          </span>
        </div>
      )}

      {!isLoading && status && settings && (
        <>
          <StatusPanel status={status} />
          <IssuerSelectorCard
            availableIssuers={status.availableIssuers}
            currentIssuer={currentIssuer}
            currentIssuerReady={status.currentIssuerReady}
            selectedIssuer={selectedIssuer}
            onSelect={setSelectedIssuer}
            onSave={handleSave}
            isSaving={updateIssuer.isPending}
            dirty={dirty}
            savedMessage={savedMessage}
            saveError={saveError}
          />
          <HelpCard />
        </>
      )}
    </div>
  );
}

// ─── Status Panel ───────────────────────────────────────────────────────────

interface StatusPanelProps {
  readonly status: NonNullable<ReturnType<typeof usePrivateWorkerTunnelStatus>['data']>['data'];
}

function StatusPanel({ status }: StatusPanelProps) {
  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm space-y-4"
      data-testid="private-worker-tunnel-status-panel"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck size={20} className="text-emerald-500" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Cert Status
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AnchorCertBadge
          ready={status.anchorCertReady}
          reason={status.anchorCertReason}
        />
        <CounterTile
          label="Issued"
          value={status.perWorkerCerts.issued}
          tone="emerald"
          testId="private-worker-cert-issued"
        />
        <CounterTile
          label="Pending"
          value={status.perWorkerCerts.pending}
          tone="amber"
          testId="private-worker-cert-pending"
        />
        <CounterTile
          label="Failed"
          value={status.perWorkerCerts.failed}
          tone="red"
          testId="private-worker-cert-failed"
        />
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700 pt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500 dark:text-gray-400">Active workers: </span>
          <span
            className="font-semibold text-gray-900 dark:text-gray-100"
            data-testid="private-worker-active-count"
          >
            {status.activeWorkerCount}
          </span>
        </div>
      </div>
    </div>
  );
}

interface AnchorCertBadgeProps {
  readonly ready: boolean;
  readonly reason: string | null;
}

function AnchorCertBadge({ ready, reason }: AnchorCertBadgeProps) {
  const failed = !ready && reason !== null;
  const pending = !ready && reason === null;

  let label: string;
  let badgeClass: string;
  let Icon: typeof ShieldCheck;

  if (ready) {
    label = 'Ready';
    badgeClass =
      'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
    Icon = ShieldCheck;
  } else if (failed) {
    label = 'Failed';
    badgeClass =
      'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';
    Icon = ShieldAlert;
  } else {
    label = 'Pending';
    badgeClass =
      'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800';
    Icon = Loader2;
  }

  return (
    <div
      className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3"
      data-testid="anchor-cert-badge"
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Anchor cert
      </div>
      <div
        className={`mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${badgeClass}`}
      >
        <Icon size={12} className={pending ? 'animate-spin' : ''} />
        <span data-testid="anchor-cert-status">{label}</span>
      </div>
      {reason && (
        <p
          className="mt-2 text-xs text-gray-600 dark:text-gray-400 break-words"
          data-testid="anchor-cert-reason"
        >
          {reason}
        </p>
      )}
    </div>
  );
}

interface CounterTileProps {
  readonly label: string;
  readonly value: number;
  readonly tone: 'emerald' | 'amber' | 'red';
  readonly testId: string;
}

function CounterTile({ label, value, tone, testId }: CounterTileProps) {
  const toneClass = {
    emerald: 'text-emerald-700 dark:text-emerald-400',
    amber: 'text-amber-700 dark:text-amber-400',
    red: 'text-red-700 dark:text-red-400',
  }[tone];

  return (
    <div
      className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3"
      data-testid={`${testId}-tile`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-bold ${toneClass}`}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Issuer Selector ────────────────────────────────────────────────────────

interface IssuerSelectorCardProps {
  readonly availableIssuers: ReadonlyArray<ClusterIssuerSummary>;
  readonly currentIssuer: string;
  readonly currentIssuerReady: boolean;
  readonly selectedIssuer: string;
  readonly onSelect: (name: string) => void;
  readonly onSave: () => void;
  readonly isSaving: boolean;
  readonly dirty: boolean;
  readonly savedMessage: string | null;
  readonly saveError: string | null;
}

function IssuerSelectorCard({
  availableIssuers,
  currentIssuer,
  currentIssuerReady,
  selectedIssuer,
  onSelect,
  onSave,
  isSaving,
  dirty,
  savedMessage,
  saveError,
}: IssuerSelectorCardProps) {
  if (availableIssuers.length === 0) {
    return <NoIssuersCard />;
  }

  // If currentIssuer isn't present in availableIssuers (e.g. operator
  // configured a non-existent name), include it as a stale option so
  // the dropdown still reflects the persisted value.
  const optionNames = availableIssuers.map((i) => i.name);
  const includesCurrent = optionNames.includes(currentIssuer);

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-sm space-y-4"
      data-testid="issuer-selector-card"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck size={20} className="text-brand-500" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          ClusterIssuer
        </h2>
      </div>

      <div>
        <label
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          htmlFor="private-worker-issuer-select"
        >
          Issuer for new worker certs
        </label>
        <select
          id="private-worker-issuer-select"
          value={selectedIssuer}
          onChange={(e) => onSelect(e.target.value)}
          className={inputClass}
          data-testid="private-worker-issuer-select"
        >
          {!includesCurrent && currentIssuer && (
            <option value={currentIssuer}>
              {currentIssuer} (current — not found in cluster)
            </option>
          )}
          {availableIssuers.map((issuer) => (
            <option key={issuer.name} value={issuer.name}>
              {issuer.name} ({ISSUER_TYPE_LABEL[issuer.type]})
              {issuer.ready ? '' : ' — not ready'}
            </option>
          ))}
        </select>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <IssuerReadyDot
            ready={availableIssuers.find((i) => i.name === selectedIssuer)?.ready ?? false}
            label="Selected ready"
          />
          <div className="text-gray-500 dark:text-gray-400">
            Current:{' '}
            <code className="text-gray-700 dark:text-gray-300" data-testid="current-issuer-name">
              {currentIssuer || '—'}
            </code>{' '}
            <IssuerReadyDot ready={currentIssuerReady} label={currentIssuerReady ? 'ready' : 'not ready'} />
          </div>
        </div>
      </div>

      {savedMessage && (
        <div
          className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300 flex items-start gap-2"
          data-testid="issuer-save-success"
        >
          <CheckCircle size={14} className="mt-0.5 shrink-0" />
          <span>{savedMessage}</span>
        </div>
      )}

      {saveError && (
        <div
          className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-400 flex items-start gap-2"
          data-testid="issuer-save-error"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-gray-100 dark:border-gray-700 pt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || isSaving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="save-issuer-button"
        >
          {isSaving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          Save Issuer
        </button>
      </div>
    </div>
  );
}

interface IssuerReadyDotProps {
  readonly ready: boolean;
  readonly label: string;
}

function IssuerReadyDot({ ready, label }: IssuerReadyDotProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          ready ? 'bg-emerald-500' : 'bg-gray-400 dark:bg-gray-500'
        }`}
        aria-hidden="true"
      />
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
    </span>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function NoIssuersCard() {
  return (
    <div
      className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-6 shadow-sm space-y-3"
      data-testid="no-issuers-card"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={20} className="text-amber-600 dark:text-amber-400" />
        <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-200">
          No ClusterIssuers found
        </h2>
      </div>
      <p className="text-sm text-amber-800 dark:text-amber-200">
        No ClusterIssuers found in cluster — install cert-manager + an issuer
        first. Until one is available, per-worker tunnel certs cannot be issued.
      </p>
      <pre className="rounded-lg bg-gray-900 text-gray-100 dark:bg-black p-3 text-xs overflow-x-auto">
        <code>{REFERENCE_ISSUER_SNIPPET}</code>
      </pre>
    </div>
  );
}

// ─── Help card ──────────────────────────────────────────────────────────────

function HelpCard() {
  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-6 shadow-sm space-y-3"
      data-testid="private-worker-tunnel-help"
    >
      <div className="flex items-center gap-2">
        <Info size={18} className="text-brand-500" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Choosing an issuer
        </h2>
      </div>
      <ul className="list-disc list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
        <li>
          <strong>HTTP-01:</strong> Use when the tunnels apex resolves to your
          ingress public IPs. No DNS provider API needed. One cert per worker.
        </li>
        <li>
          <strong>DNS-01:</strong> Use at scale or for wildcard issuance —
          requires your DNS provider's API token configured on the
          ClusterIssuer. One wildcard cert covers every worker.
        </li>
        <li>
          See{' '}
          <code className="text-gray-700 dark:text-gray-300">
            docs/04-deployment/PRIVATE_WORKER.md
          </code>{' '}
          for the full per-worker cert lifecycle and renewal model.
        </li>
      </ul>
    </div>
  );
}
