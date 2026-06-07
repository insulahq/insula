import { useState, type FormEvent } from 'react';
import { Key, Plus, Trash2, Loader2, AlertCircle, X, Copy, CheckCircle } from 'lucide-react';
import {
  useAdminLoginPasswords,
  useAdminCreateLoginPassword,
  useAdminRevokeLoginPassword,
  type AdminCreateLoginPasswordResult,
} from '@/hooks/use-email';

const INPUT =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Admin/support cross-tenant "Login passwords" manager for a mailbox
 * (ADR-049), hitting /admin/mailboxes/:id/login-passwords. Login
 * passwords are the human-facing credentials for the mailbox; the
 * secret is shown ONCE on create and revoking one never affects others.
 */
export function AdminMailboxLoginPasswordsModal({
  mailboxId,
  fullAddress,
  onClose,
}: {
  readonly mailboxId: string;
  readonly fullAddress: string;
  readonly onClose: () => void;
}) {
  const { data, isLoading } = useAdminLoginPasswords(mailboxId);
  const create = useAdminCreateLoginPassword(mailboxId);
  const revoke = useAdminRevokeLoginPassword(mailboxId);

  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [allowedIps, setAllowedIps] = useState('');
  const [revealed, setRevealed] = useState<AdminCreateLoginPasswordResult | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = data?.data ?? [];

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const ips = allowedIps.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await create.mutateAsync({
        label: label.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        allowedIps: ips.length > 0 ? ips : undefined,
      });
      setRevealed(res.data);
      setLabel(''); setExpiresAt(''); setAllowedIps(''); setShowAdvanced(false); setShowForm(false);
    } catch { /* error shown inline */ }
  };

  const copy = async () => {
    if (!revealed) return;
    try { await navigator.clipboard.writeText(revealed.secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Login passwords for ${fullAddress}`} data-testid="admin-login-passwords-modal">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Key size={16} className="text-amber-500" /> Login passwords · {fullAddress}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" data-testid="admin-login-passwords-close"><X size={16} /></button>
        </div>

        <div className="space-y-4 p-6">
          {revealed && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20 p-3 text-xs" data-testid="admin-login-password-reveal">
              <p className="font-medium text-gray-900 dark:text-gray-100">Login password "{revealed.label}" created. Shown once — store it now.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-white dark:bg-gray-900 px-2 py-1.5 font-mono text-gray-900 dark:text-gray-100" data-testid="admin-login-password-secret">{revealed.secret}</code>
                <button type="button" onClick={copy} className="rounded-md border border-gray-200 dark:border-gray-700 p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" title="Copy">
                  {copied ? <CheckCircle size={14} className="text-green-600" /> : <Copy size={14} />}
                </button>
              </div>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setRevealed(null)} className="rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600">Done</button>
              </div>
            </div>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400">
            The human-facing credentials for this mailbox — used in webmail or any mail app. Revoke
            any one without affecting the rest.
          </p>

          {!showForm ? (
            <button type="button" onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600" data-testid="admin-new-login-password">
              <Plus size={14} /> New login password
            </button>
          ) : (
            <form onSubmit={handleCreate} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Label (device name)</label>
                <input className={INPUT + ' mt-1'} value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={64} placeholder="iPhone Mail" data-testid="admin-login-password-label" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Expires <span className="text-gray-400">(optional)</span></label>
                <input type="date" className={INPUT + ' mt-1'} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </div>
              <button type="button" onClick={() => setShowAdvanced((s) => !s)} className="text-xs text-brand-600 dark:text-brand-400 hover:underline">{showAdvanced ? '▾' : '▸'} Advanced</button>
              {showAdvanced && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Restrict to IPs <span className="text-gray-400">(comma-separated CIDRs)</span></label>
                  <input className={INPUT + ' mt-1'} value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="203.0.113.4/32" />
                </div>
              )}
              {create.error && <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} />{create.error instanceof Error ? create.error.message : 'Failed'}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400">Cancel</button>
                <button type="submit" disabled={create.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="admin-login-password-submit">
                  {create.isPending && <Loader2 size={12} className="animate-spin" />} Create
                </button>
              </div>
            </form>
          )}

          {isLoading ? (
            <div className="py-6 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-500 dark:text-gray-400 italic">No login passwords yet.</p>
          ) : (
            <table className="w-full text-sm" data-testid="admin-login-passwords-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="py-2">Label</th><th className="py-2">Created</th><th className="py-2">Expires</th><th className="py-2">Restricted to</th><th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 font-medium text-gray-900 dark:text-gray-100">{r.label || <span className="italic text-gray-400">(no label)</span>}</td>
                    <td className="py-2.5 text-xs text-gray-500 dark:text-gray-400">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}</td>
                    <td className="py-2.5 text-xs text-gray-500 dark:text-gray-400">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : 'never'}</td>
                    <td className="py-2.5 text-xs text-gray-500 dark:text-gray-400">{r.allowedIps.length > 0 ? r.allowedIps.join(', ') : '—'}</td>
                    <td className="py-2.5 text-right">
                      {revokeId === r.id ? (
                        <span className="inline-flex gap-1">
                          <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(r.id, { onSuccess: () => setRevokeId(null) })} className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Revoke</button>
                          <button type="button" onClick={() => setRevokeId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-400">Cancel</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setRevokeId(r.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30">
                          <Trash2 size={11} /> Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {revoke.error && <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} />{revoke.error instanceof Error ? revoke.error.message : 'Revoke failed'}</div>}
        </div>
      </div>
    </div>
  );
}
