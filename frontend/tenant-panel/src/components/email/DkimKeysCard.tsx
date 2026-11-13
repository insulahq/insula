/**
 * DKIM signing keys of one email domain, read live from the mail server.
 *
 * This card used to ask for an endpoint that no longer existed, ignore the
 * failure, and say "No DKIM keys yet" on every domain — including ones whose
 * mail was being signed all along. So a failed read is shown as a failure,
 * and an empty list is only drawn when the mail server really holds no key.
 *
 * Rotation asks first. Each rotation reuses the selector from two rotations
 * back and replaces its key, so two in quick succession can break mail that
 * is still in transit, signed with the replaced key.
 *
 * "Show private key" hands the signing key to the tenant admin, for signing
 * with the same key on another mail server. The server asks for a fresh
 * step-up first (useStepUpGate); the key is kept in this component's state
 * only, never in the query cache, and goes when the card is hidden.
 */
import { useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, EyeOff, Key, KeyRound, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  fetchDkimPrivateKey,
  useDkimKeys,
  useEmailDomainDnsRecords,
  useRotateDkimKey,
  type DkimKey,
  type DkimPrivateKey,
  type DkimRotateResult,
  type EmailDomain,
} from '@/hooks/use-email';
import { useCanManageCerts } from '@/hooks/use-can-manage-certs';
import { useStepUpGate } from '@/hooks/use-step-up-gate';

interface DkimKeysCardProps {
  readonly tenantId: string;
  readonly domain: EmailDomain;
}

type DnsOwner = 'tenant' | 'platform' | 'unknown';

const ALGORITHM_LABEL: Record<DkimKey['algorithm'], string> = {
  rsa: 'RSA',
  ed25519: 'Ed25519',
  other: 'Other',
};

export default function DkimKeysCard({ tenantId, domain }: DkimKeysCardProps) {
  // Keys and rotation are keyed by the EMAIL-DOMAIN id; the DNS record list
  // (shared with the card above, so no second request) by the domain id.
  const { data: keysRes, isLoading, error } = useDkimKeys(tenantId, domain.id);
  const { data: dnsRes } = useEmailDomainDnsRecords(tenantId, domain.domainId);
  const rotate = useRotateDkimKey(tenantId, domain.id);
  // Not `support`, and not tenant users: the server refuses them the key.
  const canSeeKey = useCanManageCerts();
  const [confirming, setConfirming] = useState(false);
  const [lastRotation, setLastRotation] = useState<DkimRotateResult | null>(null);
  const result = keysRes?.data;
  // Unknown until the record list has loaded — then the card claims nothing
  // about who publishes the record.
  const dnsOwner: DnsOwner = dnsRes?.data ? (dnsRes.data.manualRequired ? 'tenant' : 'platform') : 'unknown';

  const handleRotate = async () => {
    setConfirming(false);
    setLastRotation(null);
    try {
      const res = await rotate.mutateAsync();
      setLastRotation(res.data);
    } catch {
      // shown below
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="dkim-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={16} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            DKIM signing keys
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={rotate.isPending || confirming || result?.provisioned === false}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="dkim-rotate-button"
        >
          {rotate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Rotate key
        </button>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Mail sent from {domain.domainName} is signed with these keys. A receiving server checks each
        signature against the TXT record of the same selector, listed under DNS records above.
      </p>

      {confirming && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 p-3 text-xs space-y-2" data-testid="dkim-rotate-confirm">
          <p className="text-amber-900 dark:text-amber-100">
            Rotating creates a new key under the other selector (<code>dkim-1</code> or{' '}
            <code>dkim-2</code>). The current key keeps signing alongside it, so mail already on its way
            still verifies. A second rotation replaces that older key, so leave several days between
            rotations — rotate only when you need to, such as yearly or after a key may have been exposed.
          </p>
          {dnsOwner === 'tenant' && (
            <p className="text-amber-900 dark:text-amber-100">
              Your DNS is hosted elsewhere: after rotating, publish the new TXT record at your DNS provider.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              data-testid="dkim-rotate-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRotate}
              className="rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600"
              data-testid="dkim-rotate-confirm-button"
            >
              Rotate now
            </button>
          </div>
        </div>
      )}

      {lastRotation && <RotationResult rotation={lastRotation} dnsOwner={dnsOwner} />}

      {rotate.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="dkim-rotate-error">
          <AlertCircle size={14} />
          {rotate.error instanceof Error ? rotate.error.message : 'Rotation failed'}
        </div>
      )}

      {isLoading && <div className="py-3 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="dkim-keys-error">
          <AlertCircle size={14} />
          {error instanceof Error ? error.message : 'Could not load the signing keys'}
        </div>
      )}

      {result && !result.provisioned && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic" data-testid="dkim-not-provisioned">
          This domain is not set up on the mail server yet, so it has no signing keys.
        </p>
      )}

      {result?.provisioned && result.keys.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400" data-testid="dkim-no-keys">
          <AlertCircle size={14} />
          The mail server holds no signing key for this domain, so its mail is not DKIM-signed.
          Rotate key creates one.
        </div>
      )}

      {result?.keys.map((k) => (
        <DkimKeyRow
          key={k.selector}
          dkimKey={k}
          action={k.current && k.stage === 'active' && canSeeKey
            ? <ShowPrivateKey tenantId={tenantId} domain={domain} />
            : null}
        />
      ))}
    </div>
  );
}

/**
 * The "Show private key" button of the signing key, and the key once shown.
 * Errors the server explains (a key made before copies were kept, an account
 * with nothing to step up with) are shown as it words them.
 */
function ShowPrivateKey({ tenantId, domain }: { readonly tenantId: string; readonly domain: EmailDomain }) {
  const gate = useStepUpGate(`the DKIM private key of ${domain.domainName}`);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<DkimPrivateKey | null>(null);

  async function show() {
    setLoading(true);
    setError(null);
    try {
      const key = await gate.run(() => fetchDkimPrivateKey(tenantId, domain.id));
      if (key) setRevealed(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the private key');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {!revealed && (
        <button
          type="button"
          onClick={() => void show()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="dkim-show-private-key"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
          Show private key
        </button>
      )}
      {error && (
        <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400" data-testid="dkim-private-key-error">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {revealed && <PrivateKeyPanel dkimKey={revealed} onHide={() => setRevealed(null)} />}
      {gate.dialog}
    </div>
  );
}

function PrivateKeyPanel({ dkimKey, onHide }: { readonly dkimKey: DkimPrivateKey; readonly onHide: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(dkimKey.privateKeyPem);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the key is on screen and selectable.
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 p-3 space-y-2" data-testid="dkim-private-key">
      <p className="flex items-start gap-1.5 text-amber-900 dark:text-amber-100">
        <ShieldAlert size={13} className="mt-0.5 shrink-0" />
        Anyone with this key can sign mail as {dkimKey.domain}. Put it only on servers you control.
      </p>
      <div className="text-gray-700 dark:text-gray-300 space-y-1">
        <p>To sign mail from another server with the same key, set it up with:</p>
        <div className="grid grid-cols-[110px_1fr] gap-1 font-mono">
          <span className="text-gray-500 dark:text-gray-400">Domain (d=)</span><code className="break-all text-gray-900 dark:text-gray-100">{dkimKey.domain}</code>
          <span className="text-gray-500 dark:text-gray-400">Selector (s=)</span><code className="break-all text-gray-900 dark:text-gray-100">{dkimKey.selector}</code>
          <span className="text-gray-500 dark:text-gray-400">Algorithm</span><span className="text-gray-900 dark:text-gray-100">{ALGORITHM_LABEL[dkimKey.algorithm]}</span>
        </div>
        <p data-testid="dkim-private-key-published">
          {dkimKey.published
            ? <>The public key is already published at <code className="break-all">{dkimKey.txtRecordName}</code>, so no DNS change is needed.</>
            : <>The platform holds no TXT record at <code className="break-all">{dkimKey.txtRecordName}</code>: publish the record above before signing elsewhere.</>}
        </p>
        <p>After a rotation here, copy the new key to the other server too: the old key keeps verifying only until the following rotation replaces it.</p>
      </div>
      <textarea
        readOnly
        value={dkimKey.privateKeyPem}
        rows={8}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-2 font-mono text-[11px] text-gray-900 dark:text-gray-100"
        aria-label={`DKIM private key for selector ${dkimKey.selector}`}
        data-testid="dkim-private-key-pem"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-600"
          data-testid="dkim-private-key-copy"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy key'}
        </button>
        <button
          type="button"
          onClick={onHide}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="dkim-private-key-hide"
        >
          <EyeOff size={12} />
          Hide
        </button>
      </div>
    </div>
  );
}

const PUBLISH_LINE: Record<DnsOwner, string> = {
  tenant: 'Publish the TXT record below at your DNS provider.',
  platform: 'The TXT record below was published automatically.',
  unknown: 'Make sure the TXT record below is published in this domain\'s DNS.',
};

function RotationResult({ rotation, dnsOwner }: { readonly rotation: DkimRotateResult; readonly dnsOwner: DnsOwner }) {
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20 p-3 text-xs" data-testid="dkim-rotate-result">
      <p className="font-medium text-gray-900 dark:text-gray-100">
        New key created under selector <code>{rotation.newSelector}</code>.{' '}
        {PUBLISH_LINE[dnsOwner]}
      </p>
      <div className="mt-2 grid grid-cols-[80px_1fr] gap-1 font-mono">
        <span className="text-gray-500 dark:text-gray-400">Type</span><span className="text-gray-900 dark:text-gray-100">TXT</span>
        <span className="text-gray-500 dark:text-gray-400">Name</span><code className="break-all text-gray-900 dark:text-gray-100">{rotation.txtRecordName}</code>
        <span className="text-gray-500 dark:text-gray-400">Value</span><code className="break-all text-gray-900 dark:text-gray-100">{rotation.txtRecordValue}</code>
      </div>
      {rotation.previousSelector && (
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          The previous key (<code>{rotation.previousSelector}</code>) keeps signing and its record stays
          published, so mail already in transit keeps verifying
          {dnsOwner !== 'platform' && ' — and so does new mail until the record above is published'}.
        </p>
      )}
    </div>
  );
}

function DkimKeyRow({ dkimKey, action }: { readonly dkimKey: DkimKey; readonly action: ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-1.5 text-xs" data-testid={`dkim-key-${dkimKey.selector}`}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-gray-900 dark:text-gray-100">{dkimKey.selector}</code>
        <StageBadge stage={dkimKey.stage} />
        <span className="text-gray-500 dark:text-gray-400">{ALGORITHM_LABEL[dkimKey.algorithm]}</span>
        {dkimKey.current && (
          <span className="rounded-md bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 font-medium text-blue-700 dark:text-blue-300">
            Newest
          </span>
        )}
      </div>
      <div className="font-mono text-gray-500 dark:text-gray-400 break-all">{dkimKey.txtRecordName}</div>
      {dkimKey.txtRecordValue === null && (
        <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400" data-testid={`dkim-no-record-${dkimKey.selector}`}>
          <AlertCircle size={12} />
          The platform holds no TXT record for this selector, so receivers cannot check its signature.
        </div>
      )}
      {action}
    </div>
  );
}

function StageBadge({ stage }: { readonly stage: string | null }) {
  if (stage === 'active') {
    return (
      <span className="inline-flex items-center rounded-md bg-green-100 dark:bg-green-900/20 px-2 py-0.5 font-medium text-green-700 dark:text-green-400">
        Signing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-0.5 font-medium text-gray-600 dark:text-gray-300">
      {stage ?? 'Stage unknown'}
    </span>
  );
}
