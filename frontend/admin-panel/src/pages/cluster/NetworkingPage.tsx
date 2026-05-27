import { useState, useEffect } from 'react';
import { Loader2, Save, CheckCircle, AlertCircle } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Cluster → Networking — ingress base domain + host-network port toggles.
 *
 * Host-network ports relax PSA for every tenant namespace from baseline
 * to privileged (see red warning in the card). The OFF→ON transition
 * is gated by an explicit confirm() naming the full impact.
 */
export default function NetworkingPage() {
  const { data: response, isLoading, isError, error } = useSystemSettings();
  const updateSettings = useUpdateSystemSettings();
  const settings = response?.data;

  const [ingressBaseDomain, setIngressBaseDomain] = useState('');
  const [allowHostPortsServer, setAllowHostPortsServer] = useState(false);
  const [allowHostPortsWorker, setAllowHostPortsWorker] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setIngressBaseDomain(settings.ingressBaseDomain ?? '');
      setAllowHostPortsServer(settings.allowHostPortsServer ?? false);
      setAllowHostPortsWorker(settings.allowHostPortsWorker ?? false);
    }
  }, [settings]);

  const handleSave = () => {
    // OFF→ON transition on host-ports has cluster-wide PSA impact;
    // require an explicit confirm() naming the consequences. The
    // confirm fires only on first-time enable per toggle — turning
    // off is recoverable, turning on widens the trust surface.
    const wasOnServer = settings?.allowHostPortsServer ?? false;
    const wasOnWorker = settings?.allowHostPortsWorker ?? false;
    const enablingServer = allowHostPortsServer && !wasOnServer;
    const enablingWorker = allowHostPortsWorker && !wasOnWorker;
    if (enablingServer || enablingWorker) {
      const which: string[] = [];
      if (enablingServer) which.push('Server');
      if (enablingWorker) which.push('Worker');
      const proceed = window.confirm(
        `Enabling "Allow Custom Host Ports on ${which.join(' + ')} Nodes" ` +
          `relaxes every tenant namespace's Pod Security Admission level from baseline ` +
          `to privileged. This also unlocks hostNetwork, hostPID, hostIPC, hostPath ` +
          `volumes, and privileged containers for ALL tenant workloads — not just the ` +
          `app you're enabling this for.\n\n` +
          `On multi-tenant clusters this materially widens the blast radius of any ` +
          `tenant-controlled deployment. Audit your custom-deployment submission ` +
          `policy before continuing.\n\n` +
          `Click OK to proceed, or Cancel to abort.`,
      );
      if (!proceed) {
        if (enablingServer) setAllowHostPortsServer(wasOnServer);
        if (enablingWorker) setAllowHostPortsWorker(wasOnWorker);
        return;
      }
    }

    setSaved(false);
    setSaveError(null);
    updateSettings.mutate(
      {
        ingressBaseDomain: ingressBaseDomain || null,
        allowHostPortsServer,
        allowHostPortsWorker,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 size={20} className="animate-spin text-brand-500" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        <AlertCircle size={16} />
        <span>Failed to load networking settings: {error?.message ?? 'Unknown error'}</span>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-6" data-testid="networking-page">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Networking</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Ingress base domain and host-network port policy</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Ingress</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Ingress Base Domain</label>
          <input
            type="text"
            value={ingressBaseDomain}
            onChange={(e) => setIngressBaseDomain(e.target.value)}
            className={INPUT_CLASS}
            placeholder="ingress.example.com"
            data-testid="ingress-base-domain-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Base domain used for CNAME routing targets (e.g., slug.ingress.example.com).
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5" data-testid="host-network-ports-card">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Host Network Ports</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          Some applications (e.g. COTURN, BBB media servers) require dedicated UDP/TCP ports on the underlying host network. Enabling these toggles lets the catalog deploy gate schedule those workloads onto the matching node role and opens the requested ports on every node of that role.
        </p>
        <p className="text-xs text-red-700 dark:text-red-300 mb-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/40 px-2 py-1.5">
          <strong>⚠ Security impact (broader than &quot;just hostPort&quot;):</strong> Enabling either toggle relaxes the Pod Security Admission level for <strong>every tenant namespace</strong> from <code>baseline</code> to <code>privileged</code>. Kubernetes&apos; PSA ladder has no <em>baseline+hostPort</em> level, so opting into host ports also unlocks <code>hostNetwork</code>, <code>hostPID</code>, <code>hostIPC</code>, <code>hostPath</code> volumes, <code>privileged: true</code> containers, and <code>allowPrivilegeEscalation: true</code> on tenant workloads. On multi-tenant clusters, audit custom-deployment submissions before turning this on — a malicious tenant could use these capabilities to escape the pod sandbox.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-300 mb-4 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 px-2 py-1">
          <strong>Note:</strong> turning a toggle <strong>off</strong> only blocks <em>new</em> deploys. Already-running workloads keep their open ports until they are deleted or redeployed manually. To force closure, delete the affected deployments after disabling. The namespace-level PSA reconcile runs eventual-consistently (~1-2s per tenant namespace) — flipping a toggle in either direction has a narrow window during which the cluster is mid-transition.
        </p>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <input
              id="allow-host-ports-server"
              type="checkbox"
              checked={allowHostPortsServer}
              onChange={(e) => setAllowHostPortsServer(e.target.checked)}
              className="mt-1 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
              data-testid="allow-host-ports-server-toggle"
            />
            <div className="flex-1">
              <label htmlFor="allow-host-ports-server" className="block text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
                Allow Custom Host Ports on Server Nodes
              </label>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                When enabled, applications declaring custom host-network ports (e.g., COTURN, BBB media servers) can be deployed onto control-plane (server) nodes. Off by default — enabling exposes the listed ports on every server node&apos;s public interface.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <input
              id="allow-host-ports-worker"
              type="checkbox"
              checked={allowHostPortsWorker}
              onChange={(e) => setAllowHostPortsWorker(e.target.checked)}
              className="mt-1 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
              data-testid="allow-host-ports-worker-toggle"
            />
            <div className="flex-1">
              <label htmlFor="allow-host-ports-worker" className="block text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
                Allow Custom Host Ports on Worker Nodes
              </label>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                When enabled, applications declaring custom host-network ports (e.g., COTURN, BBB media servers) can be deployed onto worker nodes. Off by default — enabling exposes the listed ports on every worker node&apos;s public interface.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle size={14} /> Settings saved
          </span>
        )}
        {saveError && (
          <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} /> {saveError}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettings.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="save-networking"
        >
          {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
    </div>
  );
}
