import { useState, type FormEvent } from 'react';
import { ServerCog, Plus, Loader2, AlertCircle, Trash2, RefreshCw, X, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  usePleskSources,
  useCreatePleskSource,
  useDeletePleskSource,
  useStartDiscovery,
  useLatestDiscovery,
} from '@/hooks/use-plesk-migration';
import type { PleskSourceResponse, PleskSubscription } from '@insula/api-contracts';

const INPUT = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export default function PleskMigrationPage() {
  const { data, isLoading } = usePleskSources();
  const sources = data?.data ?? [];
  const [showAdd, setShowAdd] = useState(false);

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;
  }

  return (
    <div className="space-y-6" data-testid="plesk-migration-page">
      <div className="flex items-center gap-3">
        <ServerCog size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Plesk Migration</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Register a Plesk source server and discover its subscriptions before migrating them onto the platform.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Source servers</h2>
          <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-source-button">
            {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Source'}
          </button>
        </div>

        {showAdd && <AddSourceForm onClose={() => setShowAdd(false)} />}

        {sources.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No Plesk sources registered.</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {sources.map((s) => <SourceRow key={s.id} source={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function AddSourceForm({ onClose }: { readonly onClose: () => void }) {
  const create = useCreatePleskSource();
  const [form, setForm] = useState({ name: '', hostname: '', ssh_port: '22', ssh_user: 'root', ssh_private_key: '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        name: form.name, hostname: form.hostname,
        ssh_port: Number(form.ssh_port) || 22, ssh_user: form.ssh_user || 'root',
        ssh_private_key: form.ssh_private_key,
      });
      onClose();
    } catch { /* error rendered below */ }
  };

  return (
    <form onSubmit={submit} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid="add-source-form">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2"><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label><input className={INPUT} placeholder="Customer Plesk box" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="source-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Hostname / IP</label><input className={INPUT} placeholder="plesk.example.com" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} required data-testid="source-host-input" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">SSH port</label><input type="number" className={INPUT} value={form.ssh_port} onChange={(e) => setForm({ ...form, ssh_port: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">SSH user</label><input className={INPUT} value={form.ssh_user} onChange={(e) => setForm({ ...form, ssh_user: e.target.value })} /></div>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">SSH private key (PEM)</label>
        <textarea className={`${INPUT} font-mono text-xs`} rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={form.ssh_private_key} onChange={(e) => setForm({ ...form, ssh_private_key: e.target.value })} required data-testid="source-key-input" />
        <p className="mt-0.5 text-[10px] text-gray-400">Stored encrypted at rest; never displayed again.</p>
      </div>
      {create.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{create.error instanceof Error ? create.error.message : 'Failed to add source'}</div>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={create.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-source">{create.isPending && <Loader2 size={14} className="animate-spin" />} Add Source</button>
      </div>
    </form>
  );
}

function SourceRow({ source }: { readonly source: PleskSourceResponse }) {
  const del = useDeletePleskSource();
  const discover = useStartDiscovery();
  const { data: discData } = useLatestDiscovery(source.id);
  const [confirmDel, setConfirmDel] = useState(false);
  const latest = discData?.data?.[0];
  const running = latest?.status === 'pending' || latest?.status === 'running';
  const inventory = latest?.status === 'completed' ? latest.inventory : null;

  const pwBadge = source.passwordStorage === 'sym'
    ? { icon: ShieldCheck, text: 'reversible passwords', cls: 'text-emerald-600 dark:text-emerald-400' }
    : source.passwordStorage
      ? { icon: ShieldAlert, text: `${source.passwordStorage} passwords`, cls: 'text-amber-600 dark:text-amber-400' }
      : null;

  return (
    <div className="px-5 py-4" data-testid={`source-${source.id}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{source.name}</span>
            <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-mono text-gray-600 dark:text-gray-400">{source.sshUser}@{source.hostname}:{source.sshPort}</span>
            {source.pleskVersion && <span className="text-xs text-gray-500 dark:text-gray-400">Plesk {source.pleskVersion}</span>}
            {pwBadge && <span className={`inline-flex items-center gap-1 text-xs ${pwBadge.cls}`}><pwBadge.icon size={12} />{pwBadge.text}</span>}
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {source.lastDiscoveredAt ? `Last discovered ${new Date(source.lastDiscoveredAt).toLocaleString()}` : 'Not yet discovered'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => discover.mutate(source.id)} disabled={running || discover.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50" data-testid={`discover-${source.id}`}>
            <RefreshCw size={12} className={running ? 'animate-spin' : ''} /> {running ? 'Discovering…' : 'Discover'}
          </button>
          {confirmDel ? (
            <>
              <button type="button" onClick={async () => { await del.mutateAsync(source.id); setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button>
              <button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 dark:border-red-800 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-${source.id}`}><Trash2 size={12} /></button>
          )}
        </div>
      </div>

      {latest?.status === 'failed' && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          <AlertCircle size={12} /> Discovery failed: {latest.error ?? 'unknown error'}
        </div>
      )}

      {inventory && <InventoryTable subscriptions={inventory.subscriptions} />}
    </div>
  );
}

function InventoryTable({ subscriptions }: { readonly subscriptions: readonly PleskSubscription[] }) {
  if (subscriptions.length === 0) {
    return <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No subscriptions found.</p>;
  }
  const th = 'py-1.5 pr-4 text-left text-xs font-medium text-gray-500 dark:text-gray-400';
  const td = 'py-1.5 pr-4 text-sm text-gray-700 dark:text-gray-300';
  return (
    <div className="mt-3 rounded-lg border border-gray-100 dark:border-gray-700 overflow-x-auto">
      <table className="w-full" data-testid="inventory-table">
        <thead className="bg-gray-50 dark:bg-gray-900/40">
          <tr>
            <th className={`${th} pl-3`}>Subscription</th>
            <th className={th}>Domains</th>
            <th className={th}>Mailboxes</th>
            <th className={th}>Databases</th>
            <th className={th}>Mail size</th>
            <th className={th}>Cron</th>
          </tr>
        </thead>
        <tbody>
          {subscriptions.map((s) => (
            <tr key={s.name} className="border-t border-gray-50 dark:border-gray-700/50">
              <td className={`${td} pl-3 font-medium text-gray-900 dark:text-gray-100`}>{s.name}</td>
              <td className={td}>{s.domains.length}</td>
              <td className={td}>{s.mailboxes.length}</td>
              <td className={td}>{s.databases.length}</td>
              <td className={td}>{fmtBytes(s.mailBytes)}</td>
              <td className={td}>{s.cronCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
