/**
 * Malicious Traffic Detection — the CrowdSec scenarios on the log-processing
 * agent, the second ban engine next to the WAF auto-ban scheduler.
 *
 * The scenarios read the ingress access log and ban on behaviour a WAF cannot
 * see (a stream of `/.env` probes carries no attack payload). This card is the
 * engine's whole surface: an Enable/Disable switch, the log sources the agent
 * reads, and the scenario list with each one's Bans / Alert-only mode.
 *
 * Enable/Disable is the agent's GLOBAL simulation switch, saved in
 * platform_settings. Disabled does not stop the agent: it keeps parsing and
 * raising alerts, and issues no bans. The card says exactly that, because
 * "disabled" on a security engine otherwise reads as "not even watching".
 *
 * The counters are real (`cscli metrics show scenarios` on the agent) and reset
 * when the agent restarts, which the table footnote says rather than implying a
 * total.
 */
import { Activity, AlertTriangle, FileText, Loader2 } from 'lucide-react';
import Disclosure from '@/components/ui/Disclosure';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useCrowdsecScenarios, useSetTrafficDetection } from '@/hooks/use-crowdsec';
import type { CrowdsecLogSource, CrowdsecScenariosResponse, OperatorError } from '@insula/api-contracts';
import ScenarioTable from './ScenarioTable';

const DISABLED_MEANING =
  'Disabled means the agent keeps reading the access log and raising alerts, but no scenario issues '
  + 'a ban. Your per-scenario Bans / Alert-only choices are kept and come back when you enable it again.';

export default function ScenariosCard() {
  const { data, isLoading, isError, error } = useCrowdsecScenarios();
  const payload = data?.data;
  const scenarios = payload?.scenarios ?? [];
  // What the agent RUNS (its file) — not the saved choice, which can be ahead
  // of it when an apply failed.
  const running = payload ? !payload.globalSimulation : true;

  const simulatedCount = scenarios.filter((s) => s.simulated).length;
  const activeCount = scenarios.filter((s) => s.eventsPoured > 0).length;

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
      data-testid="crowdsec-scenarios-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Activity size={15} /> Malicious Traffic Detection
            {payload && <DetectionBadge enabled={payload.detectionEnabled} />}
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-gray-600 dark:text-gray-400">
            Behaviour patterns the CrowdSec agent watches for in the ingress access log. They
            produce the <strong>Auto · Traffic</strong> bans in the Banned IPs tab — a separate
            engine from the WAF auto-ban above, which reacts to ModSecurity rule hits.
          </p>
          <p className="mt-1 max-w-3xl text-[11px] text-gray-500 dark:text-gray-400" data-testid="traffic-detection-meaning">
            {DISABLED_MEANING}
          </p>
        </div>
        {payload && <DetectionToggle payload={payload} />}
      </header>

      {!running && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="crowdsec-global-simulation"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>Malicious Traffic Detection is disabled.</strong> Every scenario is alert-only:
            alerts are still logged, no bans are issued.
          </span>
        </p>
      )}

      {isError && (
        <ErrorPanel error={extractOperatorError(error)} compact testId="crowdsec-scenarios-load-error" />
      )}
      {payload?.error && (
        <ErrorPanel error={agentUnreachable(payload.error)} severity="warn" compact testId="crowdsec-scenarios-error" />
      )}

      {payload && payload.logSources.length > 0 && <LogSources sources={payload.logSources} />}

      <Disclosure
        testId="crowdsec-scenarios-list"
        title="Scenarios"
        summary={`${scenarios.length} loaded · ${simulatedCount} alert-only · ${activeCount} have seen traffic`}
      >
        <ScenarioTable scenarios={scenarios} isLoading={isLoading} detectionRunning={running} />
      </Disclosure>
    </section>
  );
}

function agentUnreachable(detail: string): OperatorError {
  return {
    code: 'CROWDSEC_AGENT_UNREACHABLE',
    title: 'Could not reach the CrowdSec agent',
    detail,
    remediation: [
      'Check the crowdsec-agent DaemonSet in platform-system is Running.',
      'Enable / Disable still works while the agent is down — it is a saved setting.',
    ],
    retryable: true,
  };
}

function DetectionBadge({ enabled }: { readonly enabled: boolean }) {
  return enabled ? (
    <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 text-[10px] font-medium uppercase" data-testid="traffic-detection-state">
      enabled
    </span>
  ) : (
    <span className="rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-2 py-0.5 text-[10px] font-medium uppercase" data-testid="traffic-detection-state">
      disabled
    </span>
  );
}

/**
 * The Enable / Disable button. Shows the SAVED choice; when the agent does
 * not run it yet (an apply failed), says so and offers to apply it again.
 */
function DetectionToggle({ payload }: { readonly payload: CrowdsecScenariosResponse }) {
  const set = useSetTrafficDetection();
  const saved = payload.detectionEnabled;
  const notApplied = saved === payload.globalSimulation;

  const apply = (enabled: boolean) => {
    if (!enabled && !window.confirm(`Disable Malicious Traffic Detection?\n\n${DISABLED_MEANING}`)) return;
    set.mutate({ enabled });
  };

  return (
    <div className="flex max-w-md flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => apply(!saved)}
        disabled={set.isPending}
        data-testid="traffic-detection-toggle"
        aria-label={saved ? 'Disable Malicious Traffic Detection' : 'Enable Malicious Traffic Detection'}
        className={saved
          ? 'inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50'
          : 'inline-flex items-center gap-1 rounded-md border border-emerald-600 dark:border-emerald-500 bg-emerald-600 dark:bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 dark:hover:bg-emerald-600 disabled:opacity-50'}
      >
        {set.isPending && <Loader2 size={12} className="animate-spin" />}
        {saved ? 'Disable' : 'Enable'}
      </button>
      {notApplied && !set.isPending && (
        <p className="text-right text-[11px] text-amber-700 dark:text-amber-300" data-testid="traffic-detection-not-applied">
          Saved as {saved ? 'enabled' : 'disabled'}, but the agent still runs it {saved ? 'disabled' : 'enabled'}.{' '}
          <button
            type="button"
            onClick={() => set.mutate({ enabled: saved })}
            className="underline hover:no-underline"
            data-testid="traffic-detection-reapply"
          >
            Apply now
          </button>
        </p>
      )}
      {set.isError && (
        <ErrorPanel error={extractOperatorError(set.error)} compact testId="traffic-detection-error" />
      )}
      {set.data?.data.rollError && (
        <p className="text-right text-[11px] text-amber-700 dark:text-amber-300">
          Saved, but the agent could not be restarted ({set.data.data.rollError}). It applies when
          the agent next restarts.
        </p>
      )}
    </div>
  );
}

function LogSources({ sources }: { readonly sources: readonly CrowdsecLogSource[] }) {
  return (
    <Disclosure
      testId="crowdsec-log-sources"
      title={<span className="inline-flex items-center gap-1"><FileText size={12} /> Log sources</span>}
      summary={`${sources.length} source${sources.length === 1 ? '' : 's'}`}
    >
      <ul className="space-y-0.5 font-mono text-[11px] text-gray-600 dark:text-gray-400">
        {sources.map((src) => (
          <li key={`${src.type}:${src.source}`}>{src.source} <span className="opacity-60">({src.type})</span></li>
        ))}
      </ul>
      {/* Without this line a dozen SSH scenarios sitting at zero events read
          as broken detection. They are not — there is no SSH log source on
          this agent, and saying which sources exist is honest where
          computing a per-scenario "can this fire?" verdict would be a guess. */}
      <p className="mt-1.5 text-[11px] text-gray-600 dark:text-gray-400">
        A scenario can only fire on events one of these sources produces. Scenarios that
        arrived as hub dependencies for other log types will sit at zero events — that is
        expected, not a fault.
      </p>
    </Disclosure>
  );
}
