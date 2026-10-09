/**
 * User Settings → Authenticator app. Optional second factor for PASSWORD
 * sign-in (a passkey signs in on its own and is not affected).
 *
 * Off → "Set up" shows a QR code (drawn in the browser — the secret never
 * goes to a third party) and the secret as text, then a code from the app
 * turns it on and the backup codes are shown ONCE. On → status, backup codes
 * left, new backup codes, turn off; both need a code or a backup code.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, Download, Loader2, ShieldCheck } from 'lucide-react';
import { generate } from 'lean-qr';
import { toSvgDataURL } from 'lean-qr/extras/svg';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import {
  useTotpDisable,
  useTotpEnable,
  useTotpRegenerateBackupCodes,
  useTotpSetup,
  useTotpStatus,
  type TotpProofInput,
} from '@/hooks/use-totp';

const CARD = 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800';
const INPUT = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50';
const LOW_BACKUP_CODES = 3;

function QrCode({ uri }: { readonly uri: string }) {
  // Always dark-on-white: scanners read that reliably, in dark mode too.
  const src = useMemo(() => toSvgDataURL(generate(uri), { on: '#000', off: '#fff', pad: 2 }), [uri]);
  return <img src={src} alt="QR code to add this account to an authenticator app" className="h-44 w-44 rounded-md border border-gray-200 dark:border-gray-600" style={{ imageRendering: 'pixelated' }} data-testid="totp-qr" />;
}

function BackupCodes({ codes, onDone }: { readonly codes: readonly string[]; readonly onDone: () => void }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3" data-testid="totp-backup-codes">
      <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>Store these backup codes somewhere safe. Each one signs you in once without your phone. They will not be shown again.</span>
      </div>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-3 font-mono text-sm text-gray-900 dark:bg-gray-900/60 dark:text-gray-100 sm:grid-cols-3">
        {codes.map((c) => <li key={c} data-testid="totp-backup-code">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={copy} className={`${BTN} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700`}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download} className={`${BTN} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700`}>
          <Download size={14} /> Download
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} data-testid="totp-codes-stored" />
        I have stored these codes
      </label>
      <button type="button" onClick={onDone} disabled={!stored} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`} data-testid="totp-codes-done">
        Done
      </button>
    </div>
  );
}

/** "Enter a code from your app, or a backup code" — for turning off and for new backup codes. */
function ProofForm({ label, danger, pending, onSubmit, onCancel }: {
  readonly label: string;
  readonly danger?: boolean;
  readonly pending: boolean;
  readonly onSubmit: (proof: TotpProofInput) => void;
  readonly onCancel: () => void;
}) {
  const [backup, setBackup] = useState(false);
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(backup ? { backup_code: value } : { code: value });
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-2" data-testid="totp-proof-form">
      <label htmlFor="totp-proof" className="block text-sm text-gray-700 dark:text-gray-300">
        {backup ? 'A backup code' : 'A code from your authenticator app'}
      </label>
      <div className="flex flex-wrap gap-2">
        <input id="totp-proof" className={`${INPUT} max-w-[12rem] font-mono`} value={value} onChange={(e) => setValue(e.target.value)}
          inputMode={backup ? 'text' : 'numeric'} autoComplete={backup ? 'off' : 'one-time-code'} placeholder={backup ? 'XXXXX-XXXXX' : '123 456'}
          required autoFocus data-testid="totp-proof-input" />
        <button type="submit" disabled={pending || value.trim() === ''} className={`${BTN} text-white ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`} data-testid="totp-proof-submit">
          {pending && <Loader2 size={14} className="animate-spin" />} {label}
        </button>
        <button type="button" onClick={onCancel} className={`${BTN} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}>Cancel</button>
      </div>
      <button type="button" onClick={() => { setBackup((b) => !b); setValue(''); }} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
        {backup ? 'Use the authenticator app instead' : 'Use a backup code instead'}
      </button>
    </form>
  );
}

export default function TotpSection() {
  const status = useTotpStatus();
  const setup = useTotpSetup();
  const enable = useTotpEnable();
  const disable = useTotpDisable();
  const regenerate = useTotpRegenerateBackupCodes();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [action, setAction] = useState<'disable' | 'regenerate' | null>(null);

  const err = status.error ?? setup.error ?? enable.error ?? disable.error ?? regenerate.error;
  const shownError = err ? extractOperatorError(err) : null;
  const data = status.data;

  const resetFlows = () => { setup.reset(); enable.reset(); disable.reset(); regenerate.reset(); setCode(''); };

  const turnOn = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate(code, { onSuccess: (c) => { setCodes(c); setup.reset(); setCode(''); } });
  };

  return (
    <section className={CARD} data-testid="totp-section">
      <div className="mb-2 flex items-center gap-3">
        <ShieldCheck size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Authenticator app</h2>
      </div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
        Ask for a 6-digit code from an authenticator app (1Password, Google Authenticator, Aegis, …) every time you
        sign in with your password. Signing in with a passkey does not need it. Optional.
      </p>

      {shownError && <div className="mb-4"><ErrorPanel error={shownError} compact /></div>}
      {status.isLoading && <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>}

      {codes && <BackupCodes codes={codes} onDone={() => setCodes(null)} />}

      {!codes && data && !data.enabled && !setup.data && (
        <button type="button" onClick={() => { resetFlows(); setup.mutate(); }} disabled={setup.isPending} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`} data-testid="totp-setup">
          {setup.isPending && <Loader2 size={14} className="animate-spin" />} Set up authenticator app
        </button>
      )}

      {!codes && data && !data.enabled && setup.data && (
        <form onSubmit={turnOn} className="space-y-4" data-testid="totp-enroll">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <QrCode uri={setup.data.otpauthUri} />
            <div className="min-w-0 space-y-2 text-sm text-gray-700 dark:text-gray-300">
              <p>1. Scan the QR code with your authenticator app.</p>
              <p>Can't scan? Enter this key instead:</p>
              <code className="block break-all rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100" data-testid="totp-secret">{setup.data.secret}</code>
              <p>2. Enter the 6-digit code the app shows.</p>
              <div className="flex flex-wrap gap-2">
                <input className={`${INPUT} max-w-[10rem] font-mono tracking-widest`} value={code} onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" required data-testid="totp-enroll-code" aria-label="Code from the authenticator app" />
                <button type="submit" disabled={enable.isPending || code.trim() === ''} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`} data-testid="totp-enable">
                  {enable.isPending && <Loader2 size={14} className="animate-spin" />} Turn on
                </button>
                <button type="button" onClick={resetFlows} className={`${BTN} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}>Cancel</button>
              </div>
            </div>
          </div>
        </form>
      )}

      {!codes && data?.enabled && (
        <div data-testid="totp-on">
          <p className="text-sm text-gray-800 dark:text-gray-200">
            <span className="mr-2 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-200">On</span>
            since {data.enabledAt ? new Date(data.enabledAt).toLocaleDateString() : '—'} ·{' '}
            <span className={data.backupCodesRemaining <= LOW_BACKUP_CODES ? 'font-medium text-amber-700 dark:text-amber-300' : ''} data-testid="totp-backup-remaining">
              {data.backupCodesRemaining} backup code{data.backupCodesRemaining === 1 ? '' : 's'} left
            </span>
          </p>
          {data.backupCodesRemaining <= LOW_BACKUP_CODES && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Few backup codes left — make new ones.</p>
          )}
          {action === null && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => { resetFlows(); setAction('regenerate'); }} className={`${BTN} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700`} data-testid="totp-regenerate">
                New backup codes
              </button>
              <button type="button" onClick={() => { resetFlows(); setAction('disable'); }} className={`${BTN} text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20`} data-testid="totp-disable">
                Turn off
              </button>
            </div>
          )}
          {action === 'regenerate' && (
            <ProofForm label="Make new codes" pending={regenerate.isPending} onCancel={() => setAction(null)}
              onSubmit={(p) => regenerate.mutate(p, { onSuccess: (c) => { setCodes(c); setAction(null); } })} />
          )}
          {action === 'disable' && (
            <ProofForm label="Turn off" danger pending={disable.isPending} onCancel={() => setAction(null)}
              onSubmit={(p) => disable.mutate(p, { onSuccess: () => setAction(null) })} />
          )}
        </div>
      )}
    </section>
  );
}
