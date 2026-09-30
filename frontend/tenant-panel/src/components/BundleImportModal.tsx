/**
 * Import a tenant bundle from a direct upload (ADR-063).
 *
 * The flow has four places a user can be surprised, so each gets its own named
 * step rather than one spinner:
 *
 *   pick → upload (chunked, cancellable, with real progress)
 *        → inspect (reads meta.json off the uploaded archive)
 *        → REVIEW  (what will be imported, what will NOT and why, whether it fits)
 *        → import  (the Job)
 *
 * ★ REVIEW is the point of the whole dialog. An import is not reversible by a
 * button, so the user sees the exact unit list, every dropped component WITH
 * its reason, the storage headroom, and any blocker — before committing. A
 * blocked preflight disables the action and says why; a warning does not.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertTriangle, CheckCircle2, Database, FileArchive, FileText, Loader2,
  Lock, Mail, ShieldAlert, Upload, X,
} from 'lucide-react';

import { MANUAL_IMPORT_LABEL } from '@insula/api-contracts';

import { apiFetch, API_BASE } from '@/lib/api-client';
import { uploadChunked } from '@/lib/chunked-upload';

/** Mirrors `bundleImportPreflightSchema` in @insula/api-contracts. */
interface ImportPreflight {
  readonly importId: string;
  readonly format: 'tar-plain' | 'tar-encrypted' | 'zip';
  readonly sourceBundleId: string | null;
  readonly sourceTenantId: string | null;
  readonly units: ReadonlyArray<{ component: 'files' | 'mailboxes'; name: string; sizeBytes: number }>;
  readonly objectArtifacts: ReadonlyArray<{ component: 'config' | 'secrets'; name: string; sizeBytes: number }>;
  readonly dropped: ReadonlyArray<{ component: string; reason: string }>;
  readonly totalBytes: number;
  readonly stageSizeLimit: string;
  readonly quota: { limitBytes: number; incomingBytes: number; fits: boolean };
  readonly mailboxDomains: {
    ok: boolean;
    rejected: ReadonlyArray<{ address: string; domain: string; reason: string }>;
  };
  readonly warnings: ReadonlyArray<string>;
  readonly blocked: boolean;
  readonly blockReasons: ReadonlyArray<string>;
}

interface ImportResult {
  readonly bundleId: string;
  readonly sizeBytes: number;
  readonly unitCount: number;
  readonly objectCount: number;
  readonly label: string;
}

export interface BundleImportModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Fixed tenant. Omit on an admin surface that is not already per-tenant —
   *  then `tenants` is used to offer a picker. */
  readonly tenantId?: string;
  readonly scope: 'admin' | 'tenant';
  /** Admin only — offered when `tenantId` is not fixed. */
  readonly tenants?: ReadonlyArray<{ id: string; name: string }>;
  /** Admin only — the operator picks where the resulting bundle is stored. */
  readonly targets?: ReadonlyArray<{ id: string; name: string; active: boolean; readOnly?: boolean }>;
  readonly onImported?: (bundleId: string) => void;
}

type Step = 'pick' | 'uploading' | 'inspecting' | 'review' | 'importing' | 'done';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function componentIcon(component: string): ReactElement {
  if (component === 'mailboxes') return <Mail className="h-4 w-4 text-blue-500 dark:text-blue-400" />;
  if (component === 'files') return <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
  if (component === 'secrets') return <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
  return <Database className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
}

export function BundleImportModal(props: BundleImportModalProps): ReactElement | null {
  const { open, onClose, scope } = props;

  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [targetConfigId, setTargetConfigId] = useState('');
  const [pickedTenantId, setPickedTenantId] = useState('');
  const [uploaded, setUploaded] = useState(0);
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // A fixed tenant wins; otherwise the operator picks one.
  const tenantId = props.tenantId ?? pickedTenantId;
  const needsTenantPick = scope === 'admin' && !props.tenantId;
  const prefix = scope === 'admin'
    ? `/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/bundle-imports`
    : '/api/v1/tenant/bundle-imports';

  // `.enc` is how the export names an encrypted archive, so the passphrase
  // field appears from the filename alone rather than after a failed decode.
  const encrypted = useMemo(() => (file?.name ?? '').endsWith('.enc'), [file]);
  const extension = encrypted ? 'tar.gz.enc' : 'tar.gz';

  const usableTargets = useMemo(
    () => (props.targets ?? []).filter((t) => t.active && !t.readOnly),
    [props.targets],
  );

  const reset = useCallback(() => {
    setStep('pick'); setFile(null); setPassphrase(''); setLabel(''); setPickedTenantId('');
    setUploaded(0); setPreflight(null); setResult(null); setError(null);
    abortRef.current = null;
  }, []);

  const closeAndReset = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const start = useCallback(async () => {
    if (!file) return;
    setError(null);
    try {
      // The server mints the id AND the path — a panel that built
      // `.insula-import/` (singular) would upload fine and then be told the
      // archive does not exist, which reads like a server fault.
      const minted = await apiFetch<{ data: { importId: string; uploadPathFor: Record<string, string> } }>(
        `${prefix}/new-id`, { method: 'POST' },
      );
      const { importId, uploadPathFor } = minted.data;
      const path = uploadPathFor[extension];

      setStep('uploading');
      setUploaded(0);
      await uploadChunked({
        apiBase: API_BASE,
        tenantId,
        file,
        path,
        onProgress: (loaded) => setUploaded(loaded),
        onAbortable: (fn) => { abortRef.current = fn; },
      });

      setStep('inspecting');
      const pre = await apiFetch<{ data: ImportPreflight }>(`${prefix}/preflight`, {
        method: 'POST',
        body: JSON.stringify({ importId, extension, ...(passphrase ? { passphrase } : {}) }),
      });
      setPreflight(pre.data);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('pick');
    }
  }, [file, prefix, extension, tenantId, passphrase]);

  const confirmImport = useCallback(async () => {
    if (!preflight) return;
    setError(null);
    setStep('importing');
    try {
      const res = await apiFetch<{ data: ImportResult }>(prefix, {
        method: 'POST',
        body: JSON.stringify({
          importId: preflight.importId,
          extension,
          ...(passphrase ? { passphrase } : {}),
          ...(scope === 'admin' ? { targetConfigId } : {}),
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      setResult(res.data);
      setStep('done');
      props.onImported?.(res.data.bundleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  }, [preflight, prefix, extension, passphrase, scope, targetConfigId, label, props]);

  if (!open) return null;

  const pct = file && file.size > 0 ? Math.min(100, Math.round((uploaded / file.size) * 100)) : 0;
  const busy = step === 'uploading' || step === 'inspecting' || step === 'importing';
  const canStart = !!file && !!tenantId && (!encrypted || passphrase.length > 0)
    && (scope !== 'admin' || !!targetConfigId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <FileArchive className="h-5 w-5" /> Import a bundle
          </h2>
          <button
            type="button"
            onClick={busy ? undefined : closeAndReset}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 'pick' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Upload a bundle archive exported from this or another cluster. Its files and
                mailboxes are re-ingested into this tenant&apos;s backup repository, so the result
                behaves exactly like a bundle captured here — it can be browsed, restored and
                re-exported.
              </p>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Bundle archive</span>
                <input
                  type="file"
                  accept=".gz,.enc,.tar.gz,.tar.gz.enc"
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
                  className="block w-full text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm hover:file:bg-gray-200 dark:text-gray-300 dark:file:bg-gray-800 dark:hover:file:bg-gray-700"
                />
              </label>

              {file && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {file.name} — {fmtBytes(file.size)}
                  {encrypted && <span className="ml-2 text-amber-600 dark:text-amber-400">(encrypted)</span>}
                </p>
              )}

              {encrypted && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Passphrase</span>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="off"
                    className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                </label>
              )}

              {needsTenantPick && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Import into tenant</span>
                  <select
                    value={pickedTenantId}
                    onChange={(e) => setPickedTenantId(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  >
                    <option value="">Select a tenant…</option>
                    {(props.tenants ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                    The bundle is imported into THIS tenant. The tenant id recorded inside the archive is informational and is replaced.
                  </span>
                </label>
              )}

              {scope === 'admin' && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Store the imported bundle on</span>
                  <select
                    value={targetConfigId}
                    onChange={(e) => setTargetConfigId(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  >
                    <option value="">Select a backup target…</option>
                    {usableTargets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  {usableTargets.length === 0 && (
                    // Frozen and inactive targets are filtered out, so an empty
                    // list needs saying — otherwise it reads as a loading bug.
                    <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
                      No writable backup target is configured. A frozen or inactive target cannot receive an import.
                    </span>
                  )}
                </label>
              )}

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Note (optional)</span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. migrated from the old cluster"
                  maxLength={200}
                  className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
                <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                  The bundle is labelled <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{MANUAL_IMPORT_LABEL}</code>; your note is appended.
                </span>
              </label>
            </div>
          )}

          {step === 'uploading' && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <Upload className="h-4 w-4 animate-pulse" /> Uploading {file?.name}…
              </p>
              <div className="h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
                <div className="h-full bg-blue-600 transition-all dark:bg-blue-500" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {fmtBytes(uploaded)} of {fmtBytes(file?.size ?? 0)} ({pct}%)
              </p>
            </div>
          )}

          {step === 'inspecting' && (
            <p className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the bundle manifest…
            </p>
          )}

          {step === 'review' && preflight && (
            <div className="space-y-4">
              {preflight.blocked && (
                <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">This bundle cannot be imported</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {preflight.blockReasons.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Will be imported ({preflight.units.length + preflight.objectArtifacts.length})
                </h3>
                <ul className="space-y-1 text-sm">
                  {preflight.units.map((u) => (
                    <li key={`${u.component}/${u.name}`} className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                      {componentIcon(u.component)}
                      <span className="font-mono text-xs">{u.name}</span>
                      <span className="text-gray-400 dark:text-gray-500">{u.component}</span>
                    </li>
                  ))}
                  {preflight.objectArtifacts.map((a) => (
                    <li key={a.component} className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                      {componentIcon(a.component)}
                      <span className="font-mono text-xs">{a.name}</span>
                      <span className="text-gray-400 dark:text-gray-500">{a.component}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {preflight.dropped.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Will NOT be imported ({preflight.dropped.length})
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {preflight.dropped.map((d) => (
                      <li key={d.component} className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                        {componentIcon(d.component)}
                        <span><span className="font-medium">{d.component}</span> — {d.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!preflight.mailboxDomains.ok && (
                <div className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
                  <p className="font-medium text-red-800 dark:text-red-200">Mailbox domains this tenant does not own</p>
                  <ul className="mt-1 space-y-0.5 text-red-700 dark:text-red-300">
                    {preflight.mailboxDomains.rejected.slice(0, 8).map((r) => (
                      <li key={r.address} className="font-mono text-xs">{r.address}</li>
                    ))}
                  </ul>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-gray-500 dark:text-gray-400">Bundle size</dt>
                <dd className="text-gray-900 dark:text-gray-100">{fmtBytes(preflight.totalBytes)}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Storage allowance</dt>
                <dd className={preflight.quota.fits ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'}>
                  {preflight.quota.limitBytes > 0 ? fmtBytes(preflight.quota.limitBytes) : 'not set'}
                </dd>
                <dt className="text-gray-500 dark:text-gray-400">Source bundle</dt>
                <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{preflight.sourceBundleId ?? 'unknown'}</dd>
              </dl>

              {preflight.warnings.length > 0 && (
                <ul className="space-y-1">
                  {preflight.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {step === 'importing' && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <Loader2 className="h-4 w-4 animate-spin" /> Importing…
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The archive is being extracted and written into the backup repository. This runs as a
                cluster job and can take several minutes for a large bundle. Nothing is registered
                until every part has landed.
              </p>
            </div>
          )}

          {step === 'done' && result && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" /> Import complete
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-gray-500 dark:text-gray-400">Bundle</dt>
                <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{result.bundleId}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Label</dt>
                <dd className="text-gray-900 dark:text-gray-100">{result.label}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Size</dt>
                <dd className="text-gray-900 dark:text-gray-100">{fmtBytes(result.sizeBytes)}</dd>
                <dt className="text-gray-500 dark:text-gray-400">Parts</dt>
                <dd className="text-gray-900 dark:text-gray-100">{result.unitCount + result.objectCount}</dd>
              </dl>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                The uploaded archive has been removed from the tenant&apos;s file space.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          {step === 'uploading' && (
            <button
              type="button"
              onClick={() => abortRef.current?.()}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel upload
            </button>
          )}
          {step === 'pick' && (
            <>
              <button type="button" onClick={closeAndReset} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
              <button
                type="button"
                onClick={start}
                disabled={!canStart}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                Upload and inspect
              </button>
            </>
          )}
          {step === 'review' && preflight && (
            <>
              <button type="button" onClick={closeAndReset} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
              <button
                type="button"
                onClick={confirmImport}
                disabled={preflight.blocked}
                title={preflight.blocked ? preflight.blockReasons.join(' ') : undefined}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                Import {preflight.units.length} part{preflight.units.length === 1 ? '' : 's'}
              </button>
            </>
          )}
          {step === 'done' && (
            <button type="button" onClick={closeAndReset} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600">Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
