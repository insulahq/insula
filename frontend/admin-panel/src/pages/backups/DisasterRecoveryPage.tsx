/**
 * `/backups/disaster-recovery` — Disaster Recovery hub.
 *
 * Phase 5 (2026-05-22) consolidates three previously-scattered
 * surfaces into one DR page agreed with the operator:
 *
 *   1. Secrets Bundle — lifted from System Backups → Object Backups.
 *      Renders `<SecretsBundleTab>` (which already embeds
 *      `<SecretsCoverageSection>`). Bundle-everything semantics: every
 *      non-denied Secret rides along; the operator picks what to
 *      APPLY at restore time via the restore profile.
 *
 *   2. DR Drill — lifted from System Backups → DR Drill tab.
 *      `<DrDrillTab>` documents the operator-driven runbook
 *      (`scripts/integration-system-dr-drill.sh`) plus the
 *      `<DrDrillRunsSection>` for past runs.
 *
 *   3. Restore Instructions — new. Operator-context-aware
 *      copy-pasteable commands for the three recovery flows:
 *      secrets-bundle apply, postgres restore via the shim, mail
 *      restic restore via the shim. Pre-filled with the actual
 *      bound target name(s) when known; never with secrets.
 */

import { useState } from 'react';
import {
  LifeBuoy,
  ShieldCheck,
  Stethoscope,
  BookOpen,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';
import SecretsBundleTab from '@/components/system-backup/SecretsBundleTab';
import DrDrillTab from '@/components/system-backup/DrDrillTab';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';
import { useRuntimeInfo } from '@/hooks/use-runtime-info';

type Section = 'secrets' | 'drill' | 'instructions';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; icon: typeof ShieldCheck }> = [
  { id: 'secrets',      label: 'Secrets Bundle',       icon: ShieldCheck },
  { id: 'drill',        label: 'DR Drill',             icon: Stethoscope },
  { id: 'instructions', label: 'Restore Instructions', icon: BookOpen },
];

function isSection(v: string | null): v is Section {
  return SECTIONS.some((s) => s.id === v);
}

export default function DisasterRecoveryPage() {
  const url = new URL(typeof window !== 'undefined' ? window.location.href : 'http://x/');
  const initial = url.searchParams.get('section');
  const [section, setSection] = useState<Section>(isSection(initial) ? initial : 'secrets');

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start gap-3">
        <LifeBuoy size={24} className="mt-0.5 text-gray-700 dark:text-gray-300" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Disaster Recovery
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Bundles + drills + runbooks for full-cluster recovery. Per-class snapshot / backup
            restore lives on each class page; this hub covers cluster-wide DR.
          </p>
        </div>
      </header>

      <div
        role="tablist"
        aria-label="DR sections"
        className="border-b border-gray-200 dark:border-gray-700"
      >
        <div className="-mb-px flex flex-wrap gap-x-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`dr-pane-${s.id}`}
                id={`dr-tab-${s.id}-btn`}
                onClick={() => setSection(s.id)}
                data-testid={`dr-tab-${s.id}`}
                className={
                  active
                    ? 'flex items-center gap-2 border-b-2 border-brand-500 px-4 py-2 text-sm font-medium text-brand-600 dark:text-brand-300'
                    : 'flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }
              >
                <Icon size={16} />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`dr-pane-${section}`}
        aria-labelledby={`dr-tab-${section}-btn`}
        data-testid={`dr-pane-${section}`}
      >
        {section === 'secrets' && <SecretsBundleTab />}
        {section === 'drill' && <DrDrillTab />}
        {section === 'instructions' && <RestoreInstructions />}
      </div>
    </div>
  );
}

// ── Restore Instructions ──────────────────────────────────────────

interface InstructionBlockProps {
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly placeholders?: ReadonlyArray<string>;
}

function InstructionBlock({ title, description, command, placeholders }: InstructionBlockProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Browser may block clipboard in non-HTTPS / sandboxed contexts.
      window.prompt('Copy this command:', command);
    }
  };
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <p className="text-xs text-gray-600 dark:text-gray-400">{description}</p>
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${title} command`}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre className="overflow-x-auto rounded bg-gray-900 px-3 py-2 font-mono text-xs leading-relaxed text-gray-100">
        <code>{command}</code>
      </pre>
      {placeholders && placeholders.length > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Replace before running:{' '}
          {placeholders.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                {p}
              </code>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function RestoreInstructions() {
  const { data: shimResp } = useShimAssignments();
  const info = useRuntimeInfo();

  const assignments = shimResp?.data?.assignments ?? [];
  const systemTarget = assignments.find((a) => a.className === 'system')?.targetName ?? '<system-target>';
  const mailTarget = assignments.find((a) => a.className === 'mail')?.targetName ?? '<mail-target>';
  const sourceCluster = info?.environment ?? '<source-cluster-name>';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
        <div>
          <p className="font-semibold">These commands run on the recovery host, not in the admin panel.</p>
          <p className="mt-1">
            They assume you have the platform repo checked out + the bundle key in hand. Placeholders
            (<code>&lt;…&gt;</code>) are highlighted under each block — replace before running.
          </p>
        </div>
      </div>

      <InstructionBlock
        title="1. Restore the secrets bundle"
        description="Re-applies the cluster-wide Secret inventory from a bundle export. Uses the conservative restore profile (Tier-1 platform Secrets only)."
        command={`make secrets-restore \\
  BUNDLE=/path/to/secrets-bundle-YYYYMMDD.tar.age \\
  KEY=/path/to/age.key \\
  PROFILE=conservative`}
        placeholders={['/path/to/secrets-bundle-YYYYMMDD.tar.age', '/path/to/age.key']}
      />

      <InstructionBlock
        title="2. Restore Postgres from the shim"
        description="Pulls the latest base backup + WAL from the system class's bound target and promotes a new CNPG cluster from it."
        command={`scripts/restore-postgres-from-shim.sh \\
  --source-cluster ${sourceCluster} \\
  --target-cluster system-db-restored \\
  --backup-class system`}
        placeholders={sourceCluster.startsWith('<') ? ['<source-cluster-name>'] : []}
      />

      <InstructionBlock
        title="3. Restore mail (Stalwart restic)"
        description={`Restores the Stalwart RocksDB from the mail-restic shim binding (target: ${mailTarget}).`}
        command={`scripts/restore-mail-from-shim.sh \\
  --backup-class mail \\
  --restore-to /var/lib/stalwart/data \\
  --snapshot latest`}
        placeholders={mailTarget.startsWith('<') ? ['<mail-target>'] : []}
      />

      <InstructionBlock
        title="4. Verify after recovery"
        description="Smoke-tests: API health, postgres connectivity, mail JMAP login. Run from outside the cluster against the recovered external IP."
        command={`./scripts/smoke-test.sh
./scripts/integration-postgres-rw.sh
./scripts/integration-bulwark-impersonate.sh`}
      />

      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">Current operator context</h3>
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Environment</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{info?.environment ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Platform version</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{info?.version ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">System target</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{systemTarget}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Mail target</dt>
            <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{mailTarget}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
