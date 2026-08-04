import { useState, useEffect } from 'react';
import {
  X, Copy, Check, Loader2, AlertCircle, Mail, Globe, Key, ExternalLink, Info,
} from 'lucide-react';
import clsx from 'clsx';
import { useEmailConnectionInfo } from '@/hooks/use-email';
import type { EmailConnectionInfo, MailServicePort } from '@insula/api-contracts';

/**
 * "How to connect to your email accounts" — end-user setup instructions for a
 * single email domain.
 *
 * Loaded with `lazy()` from the Email page: the guide is a wall of static
 * copy that most sessions never open, so it does not belong in the main
 * bundle.
 *
 * Everything factual here (hostname, ports, socket types, webmail URLs) comes
 * from the API, never from literals in this file — the port table is the same
 * one the autodiscover/autoconfig XML is rendered from, so a client that
 * auto-configures and a user who types the settings by hand end up with
 * identical accounts.
 */

interface EmailConnectionGuideModalProps {
  readonly tenantId: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly onClose: () => void;
}

type GuideTab = 'clients' | 'webmail';

function legacyCopy(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function copyToClipboard(text: string): void {
  // writeText rejects when the page lacks clipboard permission (and throws
  // outright on http). Catch it and fall back rather than leaving an unhandled
  // rejection — a denied clipboard should degrade, not surface as an error.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
}

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { copyToClipboard(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
      aria-label={`Copy ${label}`}
      data-testid={`copy-${label}`}
    >
      {copied ? <Check size={12} className="text-green-600 dark:text-green-400" /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A labelled value the user is meant to type into a form, with a copy button. */
function SettingRow({
  label, value, hint, testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly testId: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
        <div className="break-all font-mono text-sm text-gray-900 dark:text-gray-100" data-testid={testId}>
          {value}
        </div>
        {hint && <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{hint}</div>}
      </div>
      <CopyButton value={value} label={testId} />
    </div>
  );
}

function StepHeading({ n, children }: { readonly n: number; readonly children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white">
        {n}
      </span>
      {children}
    </h4>
  );
}

function socketLabel(socketType: MailServicePort['socketType']): string {
  return socketType === 'ssl' ? 'SSL/TLS' : 'STARTTLS';
}

function ServerTable({ info }: { readonly info: EmailConnectionInfo }) {
  const incoming = info.ports.filter((p) => p.protocol !== 'smtp');
  const outgoing = info.ports.filter((p) => p.protocol === 'smtp');

  const renderRows = (rows: readonly MailServicePort[]) =>
    rows.map((p) => (
      <tr key={`${p.protocol}-${p.port}`} className="border-t border-gray-100 dark:border-gray-700">
        <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
          {p.protocol.toUpperCase()}
          {p.recommended && (
            <span className="ml-2 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              recommended
            </span>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-sm text-gray-900 dark:text-gray-100">{p.port}</td>
        <td className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">{socketLabel(p.socketType)}</td>
      </tr>
    ));

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full" data-testid="mail-ports-table">
        <thead className="bg-gray-50 dark:bg-gray-900/40">
          <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <th className="px-3 py-2">Protocol</th>
            <th className="px-3 py-2">Port</th>
            <th className="px-3 py-2">Encryption</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-gray-50/60 dark:bg-gray-900/20">
            <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
              Incoming mail (reading)
            </td>
          </tr>
          {renderRows(incoming)}
          <tr className="bg-gray-50/60 dark:bg-gray-900/20">
            <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
              Outgoing mail (sending)
            </td>
          </tr>
          {renderRows(outgoing)}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTab({ info }: { readonly info: EmailConnectionInfo }) {
  const exampleAddress = `you@${info.domainName}`;
  const hasImap = info.ports.some((p) => p.protocol === 'imap');
  const hasPop3 = info.ports.some((p) => p.protocol === 'pop3');

  return (
    <div className="space-y-6" data-testid="guide-tab-clients-content">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Use these settings in Outlook, Apple Mail, Thunderbird, Gmail&nbsp;app, K-9&nbsp;Mail — any
        mail program or phone. The same server handles both sending and receiving.
      </p>

      <section className="space-y-3">
        <StepHeading n={1}>Server address</StepHeading>
        <SettingRow
          label="Incoming and outgoing server"
          value={info.mailServerHostname}
          hint="Enter this same hostname for both incoming and outgoing mail."
          testId="mail-server-hostname"
        />
      </section>

      <section className="space-y-3">
        <StepHeading n={2}>Ports and encryption</StepHeading>
        <ServerTable info={info} />
        {hasImap && hasPop3 && (
          <p className="flex gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              Choose <strong>IMAP</strong> unless you have a reason not to — it keeps mail on the
              server so every device shows the same inbox. POP3 downloads mail to one device and is
              usually a poor fit for phones and laptops used together.
            </span>
          </p>
        )}
      </section>

      <section className="space-y-3">
        <StepHeading n={3}>Username</StepHeading>
        <SettingRow
          label="Username"
          value={exampleAddress}
          hint="Always the full email address — not just the part before the @."
          testId="mail-username-format"
        />
      </section>

      <section className="space-y-3">
        <StepHeading n={4}>Password</StepHeading>
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
            <Key size={14} /> Mail apps use an app password, not your panel login
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Each mailbox has its own app passwords (also called login passwords). The account you
            use to sign in to this panel will not work in a mail client.
          </p>
        </div>

        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <p className="font-medium text-gray-900 dark:text-gray-100">Where to get one</p>
          <ul className="list-inside list-disc space-y-1.5 text-sm text-gray-600 dark:text-gray-400">
            <li>
              <strong className="text-gray-800 dark:text-gray-200">When the mailbox was created:</strong>{' '}
              a first app password is generated automatically and shown once, right after creation.
              If it was copied then, use it.
            </li>
            <li>
              <strong className="text-gray-800 dark:text-gray-200">Any time after that:</strong> go to
              the <em>Mailboxes</em> tab, press <em>Passwords</em> on the mailbox row, then{' '}
              <em>New password</em>. Give it a label such as “iPhone” or “Outlook laptop”.
            </li>
          </ul>
          <p className="flex gap-2 rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              The password is shown <strong>once</strong> — copy it before closing the dialog. Lost
              one? Create another; you cannot look an existing one up again. Create a separate
              password per device so you can revoke a lost phone without disturbing anything else.
            </span>
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <StepHeading n={5}>Faster: let the app configure itself</StepHeading>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Most mail apps only need the email address and app password — they fetch the rest
          automatically. Try that first and fall back to the settings above if the app asks for
          them.
        </p>
      </section>
    </div>
  );
}

function WebmailTab({ info }: { readonly info: EmailConnectionInfo }) {
  const exampleAddress = `you@${info.domainName}`;
  const directUrls = [
    info.webmailUrl ? { url: info.webmailUrl, testId: 'webmail-url' } : null,
    info.webmailHostname ? { url: `https://${info.webmailHostname}`, testId: 'webmail-domain-url' } : null,
  ].filter((v): v is { url: string; testId: string } => v !== null);

  return (
    <div className="space-y-6" data-testid="guide-tab-webmail-content">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Webmail reads and sends mail in a browser, with nothing to install. There are two ways in.
      </p>

      <section className="space-y-3">
        <StepHeading n={1}>From this panel — no password needed</StepHeading>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Open the <em>Mailboxes</em> tab and press the green <em>Webmail</em> button on a mailbox
          row. You are signed straight in, because you are already signed in here. This is the
          quickest route for the account owner and needs no app password at all.
        </p>
      </section>

      <section className="space-y-3">
        <StepHeading n={2}>Directly in a browser — for the mailbox user</StepHeading>
        {directUrls.length > 0 ? (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Give this address to the person who owns the mailbox. They can bookmark it and sign in
              without access to this panel.
            </p>
            <div className="space-y-2">
              {directUrls.map((d) => (
                <div key={d.url} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1.5 break-all font-mono text-sm text-brand-600 dark:text-brand-400 hover:underline"
                    data-testid={d.testId}
                  >
                    <ExternalLink size={12} className="shrink-0" />
                    {d.url}
                  </a>
                  <CopyButton value={d.url} label={d.testId} />
                </div>
              ))}
            </div>
            <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Sign in with</p>
              <SettingRow
                label="Username"
                value={exampleAddress}
                hint="The full email address."
                testId="webmail-username-format"
              />
              <p className="flex gap-2 text-xs text-gray-600 dark:text-gray-400">
                <Key size={14} className="mt-0.5 shrink-0 text-amber-500" />
                <span>
                  Password: an <strong>app password</strong> for that mailbox — the same kind mail
                  apps use. Create one under <em>Mailboxes</em> → <em>Passwords</em> →{' '}
                  <em>New password</em>, and hand it to the user along with this link. It is shown
                  once, so copy it before closing that dialog.
                </span>
              </p>
            </div>
          </>
        ) : (
          <p className="flex gap-2 rounded-lg bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-sm text-gray-600 dark:text-gray-400" data-testid="webmail-url-unavailable">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              No direct webmail address is configured for this platform yet. Use the{' '}
              <em>Webmail</em> button on the Mailboxes tab, or ask your provider to publish one.
            </span>
          </p>
        )}
      </section>

      <section className="space-y-3">
        <StepHeading n={3}>Which should you use?</StepHeading>
        <ul className="list-inside list-disc space-y-1.5 text-sm text-gray-600 dark:text-gray-400">
          <li>Checking a mailbox yourself, occasionally → the panel button.</li>
          <li>Handing a mailbox to a colleague or client → the direct link plus an app password.</li>
          <li>Daily use on a phone or laptop → set up a mail app instead (see the other tab).</li>
        </ul>
      </section>
    </div>
  );
}

export default function EmailConnectionGuideModal({
  tenantId, domainId, domainName, onClose,
}: EmailConnectionGuideModalProps) {
  const [tab, setTab] = useState<GuideTab>('clients');
  const { data, isLoading, error } = useEmailConnectionInfo(tenantId, domainId);
  const info = data?.data;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const tabs: readonly { readonly key: GuideTab; readonly label: string; readonly icon: React.ReactNode }[] = [
    { key: 'clients', label: 'Email clients', icon: <Mail size={14} /> },
    { key: 'webmail', label: 'Webmail', icon: <Globe size={14} /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-guide-title"
      data-testid="email-connection-guide-modal"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-2xl flex-col rounded-xl bg-white dark:bg-gray-800 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div>
            <h2 id="email-guide-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              How to connect to your email accounts
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">{domainName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
            data-testid="close-email-guide"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700 px-5">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={clsx(
                'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium',
                tab === t.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
              )}
              data-testid={`guide-tab-${t.key}`}
              aria-current={tab === t.key}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="flex justify-center py-12" data-testid="email-guide-loading">
              <Loader2 size={22} className="animate-spin text-brand-500" />
            </div>
          )}
          {!isLoading && (error || !info) && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300" data-testid="email-guide-error">
              <AlertCircle size={16} />
              {error instanceof Error ? error.message : 'Could not load the connection settings. Please try again.'}
            </div>
          )}
          {!isLoading && info && tab === 'clients' && <ClientsTab info={info} />}
          {!isLoading && info && tab === 'webmail' && <WebmailTab info={info} />}
        </div>

        <div className="flex justify-end border-t border-gray-200 dark:border-gray-700 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            data-testid="email-guide-close-button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
