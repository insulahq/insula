import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Loader2, Copy, CheckCircle, KeyRound } from 'lucide-react';
import { useCreateTenant, useDeleteTenant } from '@/hooks/use-tenants';
import { useTriggerProvisioning } from '@/hooks/use-provisioning';
import { usePlans, useRegions } from '@/hooks/use-plans';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useWorkerUsageSummary, type WorkerUsage } from '@/hooks/use-worker-usage';
import ProvisioningProgressModal from './ProvisioningProgressModal';

/**
 * Same "free / total" formatter as PlacementCard. Kept colocated rather
 * than extracted to a shared util because both call sites are in the
 * same admin-panel and the formatting is dropdown-specific.
 */
function formatAvailability(usage: WorkerUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.cpuMillicoresAllocatable != null && usage.cpuMillicoresUsed != null) {
    const total = usage.cpuMillicoresAllocatable / 1000;
    const free = Math.max(0, (usage.cpuMillicoresAllocatable - usage.cpuMillicoresUsed) / 1000);
    parts.push(`${free.toFixed(2)}/${total.toFixed(0)} CPUs`);
  }
  if (usage.memoryBytesAllocatable != null && usage.memoryBytesUsed != null) {
    const total = usage.memoryBytesAllocatable / 1024 ** 3;
    const free = Math.max(0, (usage.memoryBytesAllocatable - usage.memoryBytesUsed) / 1024 ** 3);
    parts.push(`${free.toFixed(1)}/${total.toFixed(0)} GB RAM`);
  }
  if (usage.diskBytesTotal != null && usage.diskBytesFree != null) {
    const total = usage.diskBytesTotal / 1024 ** 3;
    const free = usage.diskBytesFree / 1024 ** 3;
    parts.push(`${free.toFixed(0)}/${total.toFixed(0)} GB disk`);
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')} available` : '';
}

interface CreateTenantModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

interface CreatedTenant {
  readonly id: string;
  readonly name: string;
  readonly credentials: { email: string; password: string } | null;
}

export default function CreateTenantModal({ open, onClose }: CreateTenantModalProps) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [primaryEmail, setPrimaryEmail] = useState('');
  const [secondaryEmail, setSecondaryEmail] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [billingStreetAddress, setBillingStreetAddress] = useState('');
  const [billingPostalAddress, setBillingPostalAddress] = useState('');
  const [billingCity, setBillingCity] = useState('');
  const [billingCountry, setBillingCountry] = useState('');
  const [planId, setPlanId] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [storageTier, setStorageTier] = useState<'local' | 'ha'>('local');

  const { data: plansData } = usePlans();
  const { data: regionsData } = useRegions();
  const { data: nodesData } = useClusterNodes();
  const { data: usageData } = useWorkerUsageSummary();
  const usageByName = new Map((usageData?.data ?? []).map((u) => [u.name, u]));
  const createTenant = useCreateTenant();
  const deleteTenant = useDeleteTenant();
  const triggerProvisioning = useTriggerProvisioning();
  // Three internal views: form (before submit), credentials (after submit,
  // before ack), provisioning (credentials acked, watching k8s steps).
  const [createdTenant, setCreatedTenant] = useState<CreatedTenant | null>(null);
  const [view, setView] = useState<'form' | 'credentials' | 'provisioning'>('form');
  const [copied, setCopied] = useState(false);

  const plans = plansData?.data ?? [];
  const regions = regionsData?.data ?? [];

  const resetForm = () => {
    setName('');
    setContactName('');
    setPrimaryEmail('');
    setSecondaryEmail('');
    setPhoneE164('');
    setBillingStreetAddress('');
    setBillingPostalAddress('');
    setBillingCity('');
    setBillingCountry('');
    setPlanId('');
    setNodeName('');
    setStorageTier('local');
    setCreatedTenant(null);
    setView('form');
    setCopied(false);
    createTenant.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await createTenant.mutateAsync({
        name,
        contact_name: contactName,
        primary_email: primaryEmail,
        secondary_email: secondaryEmail || undefined,
        phone_e164: phoneE164,
        billing_address: {
          street_address: billingStreetAddress,
          postal_address: billingPostalAddress,
          city: billingCity,
          country: billingCountry,
        },
        plan_id: planId,
        // region_id intentionally omitted — server auto-fills platform apex region.
        node_name: nodeName || undefined,
        storage_tier: storageTier,
      });
      const data = result.data;
      if (!data.id) {
        // Missing id in response — cannot proceed to provisioning view.
        handleClose();
        return;
      }
      setCreatedTenant({
        id: data.id,
        name: name,
        credentials: data.tenantUser?.generatedPassword
          ? { email: data.tenantUser.email, password: data.tenantUser.generatedPassword }
          : null,
      });
      setView(data.tenantUser?.generatedPassword ? 'credentials' : 'provisioning');
    } catch {
      // error displayed in modal
    }
  };

  const handleProceedToProvisioning = () => {
    setView('provisioning');
  };

  const handleProvisioningSuccess = () => {
    if (!createdTenant) return;
    const tenantId = createdTenant.id;
    // Close modal first so navigation doesn't race with the unmount.
    handleClose();
    navigate(`/tenants/${tenantId}`);
  };

  const handleCleanupArtifacts = async () => {
    if (!createdTenant) return;
    try {
      await deleteTenant.mutateAsync(createdTenant.id);
      handleClose();
    } catch {
      // error surfaced through the mutation — let user retry
    }
  };

  const handleRetryProvisioning = async () => {
    if (!createdTenant) return;
    try {
      await triggerProvisioning.mutateAsync({ tenantId: createdTenant.id });
    } catch {
      // surfaced via task poll — error stays visible in modal
    }
  };

  if (!open) return null;

  // When we've advanced to provisioning view, render ProvisioningProgressModal
  // as the sole dialog. Credentials (if any) are pinned on top so the admin
  // still has one chance to copy them.
  if (view === 'provisioning' && createdTenant) {
    return (
      <ProvisioningProgressModal
        tenantId={createdTenant.id}
        tenantName={createdTenant.name}
        onClose={handleClose}
        onSuccess={handleProvisioningSuccess}
        onCleanup={handleCleanupArtifacts}
        onRetry={handleRetryProvisioning}
        isCleaningUp={deleteTenant.isPending}
        isRetrying={triggerProvisioning.isPending}
      />
    );
  }

  const credentials = createdTenant?.credentials ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-tenant-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Client</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {view === 'credentials' && credentials && (
          <div className="space-y-4" data-testid="tenant-credentials">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle size={20} />
              <span className="text-sm font-medium">Client created successfully!</span>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-4">
              <div className="flex items-center gap-2 mb-3">
                <KeyRound size={16} className="text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">Client Portal Credentials</span>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">Save these credentials now. The password will not be shown again.</p>
              <div className="space-y-2 text-sm">
                <div><span className="text-gray-500">Email:</span> <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{credentials.email}</span></div>
                <div><span className="text-gray-500">Password:</span> <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{credentials.password}</span></div>
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`Email: ${credentials.email}\nPassword: ${credentials.password}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/20"
                data-testid="copy-credentials"
              >
                {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Credentials'}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleProceedToProvisioning}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
                data-testid="close-credentials"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {view === 'form' && createTenant.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="create-error">
            {createTenant.error instanceof Error ? createTenant.error.message : 'Failed to create tenant'}
          </div>
        )}

        {view === 'form' && <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-tenant-form">
          <div>
            <label htmlFor="tenant-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name *
            </label>
            <input
              id="tenant-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Acme Corp"
              data-testid="tenant-name-input"
            />
          </div>

          <div>
            <label htmlFor="contact-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Contact Name *
            </label>
            <input
              id="contact-name"
              type="text"
              required
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Jane Doe"
              data-testid="contact-name-input"
            />
          </div>

          <div>
            <label htmlFor="primary-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Primary Email *
            </label>
            <input
              id="primary-email"
              type="email"
              required
              value={primaryEmail}
              onChange={(e) => setPrimaryEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="admin@acme.com"
              data-testid="primary-email-input"
            />
          </div>

          <div>
            <label htmlFor="secondary-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Secondary Email
            </label>
            <input
              id="secondary-email"
              type="email"
              value={secondaryEmail}
              onChange={(e) => setSecondaryEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="support@acme.com (optional)"
              data-testid="secondary-email-input"
            />
          </div>

          <div>
            <label htmlFor="phone-e164" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Tenant Phone *
            </label>
            <input
              id="phone-e164"
              type="tel"
              required
              value={phoneE164}
              onChange={(e) => setPhoneE164(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="+14155552671"
              pattern="^\+[1-9]\d{1,14}$"
              data-testid="phone-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">ITU-T E.164 format (leading +, country code, no spaces).</p>
          </div>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">Billing Address</legend>
            <div>
              <label htmlFor="billing-street" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Street Address *
              </label>
              <input
                id="billing-street"
                type="text"
                required
                value={billingStreetAddress}
                onChange={(e) => setBillingStreetAddress(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="123 Main Street"
                data-testid="billing-street-input"
              />
            </div>
            <div>
              <label htmlFor="billing-postal" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Postal Address *
              </label>
              <input
                id="billing-postal"
                type="text"
                required
                value={billingPostalAddress}
                onChange={(e) => setBillingPostalAddress(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="P.O. Box 456 or same as Street"
                data-testid="billing-postal-input"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="billing-city" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                  City *
                </label>
                <input
                  id="billing-city"
                  type="text"
                  required
                  value={billingCity}
                  onChange={(e) => setBillingCity(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="San Francisco"
                  data-testid="billing-city-input"
                />
              </div>
              <div>
                <label htmlFor="billing-country" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Country *
                </label>
                <input
                  id="billing-country"
                  type="text"
                  required
                  value={billingCountry}
                  onChange={(e) => setBillingCountry(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="US"
                  data-testid="billing-country-input"
                />
              </div>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="plan" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Plan *
              </label>
              <select
                id="plan"
                required
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="plan-select"
              >
                <option value="">Select plan...</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (${p.monthlyPriceUsd}/mo)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="node" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Node (primary data location)
              </label>
              <select
                id="node"
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="worker-select"
              >
                <option value="">Auto (recommended — scheduler picks based on capacity)</option>
                {(nodesData?.data ?? [])
                  .filter((n) => n.canHostTenantWorkloads)
                  .map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
                      {formatAvailability(usageByName.get(n.name))}
                    </option>
                  ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Pod and primary Longhorn replica land on this node. Auto picks the node with most free capacity at provisioning. HA tier can fail over to other nodes.
              </p>
            </div>

            <div>
              <label htmlFor="storage-tier" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Storage tier
              </label>
              <select
                id="storage-tier"
                value={storageTier}
                onChange={(e) => setStorageTier(e.target.value as 'local' | 'ha')}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="storage-tier-select"
              >
                <option value="local">Local (1 replica — default)</option>
                <option value="ha" disabled={(nodesData?.data ?? []).filter((n) => n.canHostTenantWorkloads).length < 3}>
                  HA (2 replicas — longhorn-tenant-ha)
                  {(nodesData?.data ?? []).filter((n) => n.canHostTenantWorkloads).length < 3
                    && ` — needs ≥3 worker nodes`}
                </option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                HA costs 2× storage and requires ≥3 tenant-capable nodes to stay fully replicated.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTenant.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-button"
            >
              {createTenant.isPending && <Loader2 size={14} className="animate-spin" />}
              Create Client
            </button>
          </div>
        </form>}
      </div>
    </div>
  );
}
