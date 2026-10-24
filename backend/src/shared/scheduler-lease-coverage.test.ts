/**
 * Every recurring timer in platform-api is a decision: behind a lease, so one
 * replica runs it — or on every replica, for a stated reason.
 *
 * HA runs three replicas and every in-process timer starts on each. Jobs were
 * found running three times (restic prunes colliding on the repository lock, a
 * bandwidth window billed twice, an expired tenant suspended twice, an app
 * upgraded by two replicas at once). The first version of this test listed
 * the leased jobs and checked only those, so a timer nobody added to the list
 * was never looked at: the backup-freshness sweep started a mail-listing Job
 * on every replica every five minutes.
 *
 * So this test finds the timers itself, by parsing the source. A file that
 * starts one — an interval, a function that re-arms itself with a timeout, a
 * loop that runs until the process stops — must account for each: a leased
 * job in LEASED, or a reason in EVERY_REPLICA. A new timer fails here until it
 * is classified.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

/**
 * The leased jobs. An entry accounts for one timer in its file unless it says
 * otherwise: `timers: 0` for a lease taken by something that is not a timer of
 * its own (a start-up run, or one half of a timer that otherwise runs
 * everywhere), `timers: 2` for a job with a second timer under the same lease.
 */
const LEASED: ReadonlyArray<{ file: string; job: string; timers?: number }> = [
  { file: 'modules/tenant-bundles/restic-retention.ts', job: 'restic-retention' },
  { file: 'modules/system-backup/footprint-scheduler.ts', job: 'system-backup-footprint' },
  { file: 'modules/tenant-bundles/retention.ts', job: 'bundle-retention' },
  { file: 'modules/bandwidth/meter.ts', job: 'bandwidth-meter' },
  { file: 'modules/tenant-lifecycle/scheduler.ts', job: 'lifecycle-hook-retry' },
  { file: 'server.ts', job: 'subscription-expiry' },
  { file: 'server.ts', job: 'deployment-auto-upgrade' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-auto-archive' },
  { file: 'modules/custom-deployments/auto-update-scheduler.ts', job: 'custom-deployment-auto-update' },
  { file: 'modules/notifications/digest/scheduler.ts', job: 'notification-digest' },
  { file: 'modules/notifications/queue/scanner.ts', job: 'notification-reenqueue-scan' },
  { file: 'modules/mail-imapsync/scheduler.ts', job: 'mail-imapsync-reconciler' },
  { file: 'app.ts', job: 'mail-self-heal' },
  { file: 'app.ts', job: 'multihost-remediation-boot', timers: 0 },
  // The interval, and the follow-up tick it arms after recycling the mail server.
  { file: 'modules/mail-admin/stalwart-domain-reconciler.ts', job: 'stalwart-domain-reconciler', timers: 2 },
  { file: 'modules/storage/image-pressure-watcher.ts', job: 'image-pressure-watcher' },
  { file: 'modules/storage/image-prune-scheduler.ts', job: 'daily-image-prune' },
  { file: 'modules/crowdsec-autoban/scheduler.ts', job: 'crowdsec-autoban' },
  { file: 'modules/domains/verification-cron.ts', job: 'domain-verification' },
  { file: 'modules/dns-apex-drift/scheduler.ts', job: 'dns-route-drift-scan' },
  // Pollers of the Kubernetes API. Not unsafe to run three times, but three
  // replicas each listing every pod/Deployment/Node/Certificate on a short
  // cadence was most of the apiserver traffic crossing between the nodes.
  { file: 'app.ts', job: 'deployment-status-reconcile' },
  { file: 'app.ts', job: 'certificate-status-reconcile' },
  { file: 'modules/file-manager/idle-cleanup.ts', job: 'file-manager-idle-cleanup' },
  { file: 'modules/ingress-routes/waf-log-scraper.ts', job: 'waf-log-scraper' },
  { file: 'modules/nodes/scheduler.ts', job: 'node-sync' },
  { file: 'modules/tenant-health/scheduler.ts', job: 'tenant-auto-repin' },
  { file: 'modules/tenant-placement/reconciler.ts', job: 'tenant-placement' },
  { file: 'modules/cluster-health/scheduler.ts', job: 'node-subsystem-health' },
  { file: 'modules/node-health/scheduler.ts', job: 'node-health-monitor' },
  { file: 'modules/cluster-settings/kubelet-gc-reconciler.ts', job: 'kubelet-gc-reconciler' },
  { file: 'modules/system-pod-placement/scheduler.ts', job: 'system-pod-placement' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'tenant-workload-health' },
  { file: 'modules/mail-admin/proxy-networks-reconciler.ts', job: 'mail-proxy-networks' },
  { file: 'modules/mcp/reaper.ts', job: 'mcp-token-reaper' },
  { file: 'modules/platform-upgrades/auto-update.ts', job: 'auto-update' },
  // A run lock around each pass of the upgrade reconciler, whose timer runs on
  // every replica behind its own short per-tick claim.
  { file: 'modules/platform-upgrades/scheduler.ts', job: 'platform-upgrade-pass', timers: 0 },
  // Watchers that alert. A notification's dedupe key is checked by a lookup,
  // not a constraint, so replicas ticking together each send it.
  { file: 'modules/backup-health/freshness-sweep.ts', job: 'backup-freshness' },
  { file: 'modules/backup-health/scheduler.ts', job: 'backup-job-health' },
  { file: 'modules/cnpg-backup-health/scheduler.ts', job: 'cnpg-backup-health' },
  { file: 'modules/wal-archive-health/scheduler.ts', job: 'wal-archive-health' },
  { file: 'modules/mail-admin/blocklist-scheduler.ts', job: 'mail-blocklist-watch' },
  { file: 'modules/mail-admin/health-scheduler.ts', job: 'mail-health-watch' },
  { file: 'modules/mail-admin/standby-prepare-task.ts', job: 'mail-standby-prepare-watch' },
  { file: 'modules/notifications/escalation/scheduler.ts', job: 'notification-escalation' },
  { file: 'modules/subscriptions/expiry-warning-scheduler.ts', job: 'subscription-expiry-warning' },
  { file: 'modules/platform-storage-policy/capacity-reconciler.ts', job: 'storage-capacity-watch' },
  { file: 'modules/platform-storage-policy/scheduler.ts', job: 'storage-policy-advisor' },
  { file: 'modules/monitoring/scheduler.ts', job: 'monitoring-evaluator' },
  { file: 'modules/backup-rclone-shim/dr-cronjobs-scheduler.ts', job: 'dr-cronjobs-reconciler' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'namespace-integrity' },
  // Syncs against the mail server: full listings, and writes that are
  // check-then-create.
  { file: 'modules/stalwart-jmap/principals-sync.ts', job: 'stalwart-principals-sync' },
  { file: 'modules/mail-stats/scheduler.ts', job: 'mailbox-usage-sync' },
  { file: 'app.ts', job: 'mail-convergence-sweep' },
  // Sweeps that start Jobs or pods, exec into one, or delete volumes.
  { file: 'modules/mail-admin/mail-pvc-reaper.ts', job: 'mail-pvc-reaper' },
  { file: 'modules/login-passwords/login-password-reaper.ts', job: 'login-password-reaper' },
  { file: 'modules/file-manager/trash-reconciler.ts', job: 'file-trash-reconcile' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-snapshot-expiry' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-audit' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-quiesce-watchdog' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-op-pick-up' },
  { file: 'modules/orphaned-volumes/janitor.ts', job: 'released-pv-janitor' },
  { file: 'modules/postgres-restore/watchdog.ts', job: 'released-pv-reaper', timers: 0 },
  { file: 'modules/longhorn-recurring-jobs/scheduler.ts', job: 'longhorn-recurring-jobs' },
  { file: 'modules/security-hardening/crowdsec-bouncer-prune-scheduler.ts', job: 'crowdsec-bouncer-prune' },
  // Convergers where two replicas at once roll a workload twice, or cancel
  // each other's first-run step.
  { file: 'modules/backup-rclone-shim/scheduler.ts', job: 'backup-rclone-shim' },
  { file: 'modules/cluster-trusted-proxies/scheduler.ts', job: 'cluster-trusted-proxies' },
  { file: 'modules/crowdsec-db/reconciler.ts', job: 'crowdsec-db-reconciler' },
  { file: 'modules/waf-rule-exclusions/scheduler.ts', job: 'waf-rule-exclusions' },
  // Deletes DR artefacts past their retention; two replicas would race the deletes.
  { file: 'modules/backup-schedules/dr-artefact-retention.ts', job: 'dr-artefact-retention' },
  // Lists every backup target; once per cluster is the whole point of the cadence.
  { file: 'modules/backup-config/target-usage.ts', job: 'backup-target-usage' },
  // Migrates tenants' pods; two replicas would race the same namespace.
  { file: 'modules/cpu-migration/auto-migrate.ts', job: 'cpu-auto-migrate' },
];

/**
 * Timers that run on every replica, by file — one reason per timer.
 *
 * Four kinds of reason: the timer belongs to one connection or one task in
 * this process; it feeds this process's own memory or gauges; its work is
 * claimed atomically, so a second replica gets nothing to do; or it converges
 * to a value that every replica derives identically and writes only on drift.
 */
const EVERY_REPLICA: Readonly<Record<string, readonly string[]>> = {
  // ── where it runs is the point ────────────────────────────────────────────
  'modules/mail-admin/dr-watcher.ts': [
    'a replica on the failed mail node sits the failover out so one on a healthy node does it; a single holder stuck on the dead node would keep renewing and no failover would happen',
  ],
  'modules/node-health/fast-down-watch.ts': [
    'if the holder dies with its node, the replica taking over starts without a baseline and never announces that very node',
  ],
  'modules/platform-upgrades/scheduler.ts': [
    'takes its own short per-tick claim instead of one sticky replica, because an upgrade restarts the replicas themselves; a pass in flight holds a run lock',
  ],
  // ── one connection or one task in this process ────────────────────────────
  'modules/container-console/routes.ts': [
    'log stream: watches the pods behind one open connection',
    'log stream: keep-alive ping of one open connection',
    'shell: keep-alive ping of one open connection',
  ],
  'modules/node-terminal/service.ts': ['keep-alive ping of one open terminal connection'],
  'modules/node-terminal/scheduler.ts': ['closes terminal sessions whose socket lives in this process'],
  'modules/tasks/routes.ts': ['keep-alive frame of one open event stream'],
  'modules/dr-recover/liveness.ts': ['heartbeat of a recovery running in this process'],
  'modules/dr-recover/task-reporter.ts': ['progress ticker of a recovery running in this process'],
  'modules/file-manager/lease.ts': ['renewal of a file-manager hold taken by this process'],
  'modules/mail-admin/task-liveness.ts': ['renewal of the liveness lease of a mail task running in this process'],
  'modules/tenant-bundles/cluster-concurrency.ts': ['heartbeat of a backup stream running in this process'],
  'shared/scheduler-lease.ts': [
    'renewal of a lease this process holds, while its job runs',
    'keep-alive of the long leases this process holds, between its runs',
    'the later tries of a start-up run that was refused: two at most, then it stops',
  ],
  // ── this process's own memory and gauges ──────────────────────────────────
  'modules/mail-events/mail-health-collector.ts': ['sets only the gauges this process serves'],
  'modules/monitoring/flux-status-collector.ts': ['sets only the gauge this process serves'],
  'modules/monitoring/ingress-router-collector.ts': ['a read-only probe that sets only the gauge this process serves'],
  'modules/traffic/node-traffic-collector.ts': ['one namespaced read that refreshes only the gauges this process serves'],
  'modules/ingress-spool-reaper/scheduler.ts': [
    'publishes the spool gauge this process serves — under a lease the other replicas would export a stale or empty one; the sweep is an idempotent find-and-delete',
  ],
  'modules/metrics/metrics-scheduler.ts': [
    "fills this process's metrics cache; its shared writes are claimed by one guarded statement or are idempotent upserts",
  ],
  'modules/postgres-restore/watchdog.ts': [
    'the stuck-restore check clears this process\'s own "a restore is running" flag; the volume reaper half of the tick is leased',
  ],
  // ── the work is claimed atomically ────────────────────────────────────────
  'modules/cron-jobs/scheduler.ts': ['each due job is claimed atomically before it runs'],
  'modules/tenant-bundles/global-scheduler.ts': ['the wave is claimed by a conditional UPDATE of the last fired minute'],
  'modules/mail-admin/snapshot-prune.ts': ['the prune is claimed by a conditional upsert of its next-due time'],
  'modules/mail-admin/snapshot-cronjob-scheduler.ts': [
    "reconcile: feeds this process's desired state, which its own drift and fire checks read; patches the CronJob only on drift",
    "drift check: read-only against this process's desired state",
    'fire check: claimed by a conditional UPDATE of the last fired minute, behind a Job name that carries the minute',
  ],
  'modules/backup-schedules/cadence/scheduler.ts': [
    'reconcile: patches the backup schedules only on drift',
    'fire: the Job name carries the fired minute, so a second create is a handled conflict',
  ],
  'modules/system-backup/sweeper.ts': ['conditional UPDATE and DELETE … RETURNING, which match nothing on a second run'],
  // ── idempotent: a second run changes nothing ──────────────────────────────
  'modules/backup-rclone-shim/etcd-cronjob-scheduler.ts': [
    'patches the CronJob only where it drifted; its one generated input, the cluster id, is settled by INSERT … ON CONFLICT DO NOTHING',
  ],
  'modules/backup-rclone-shim/mail-restic-scheduler.ts': [
    'the repository Secret is derived from the backup key and the cluster id, and the API token Secret is rewritten only on drift — replicas write identical values and nothing is rolled',
  ],
  'modules/backup-rclone-shim/postgres-objectstore-scheduler.ts': [
    'deterministic merge-patches; the database cluster is patched only when its plugin entry differs',
  ],
  'modules/db-isolation/reconciler.ts': ['re-asserts a fixed access list in one transaction, identical from every replica'],
  'modules/roundcube-db-reconciler/reconciler.ts': ['copies an existing Secret value into the database role and never generates one'],
  'modules/webmail-feature-css/scheduler.ts': ['output is a pure function of three settings and every write is guarded by a compare'],
  'modules/webmail-router/scheduler.ts': ['reads live state and writes only on drift, from two settings'],
  'modules/email-domains/webmail-reconciler.ts': ['writes absolute status values, and a promoted row leaves the candidate set'],
  'modules/ingress-nodes/reconciler.ts': ['writes only when the discovered address set changed, from the node list every replica reads'],
  'modules/mail-admin/imap-concurrency.ts': ['sets a fixed value, and only when the live one differs'],
  'modules/mail-admin/dns-resolver-reconciler.ts': ['sets a fixed value, and only when the live one differs; the settings reload it triggers is idempotent'],
  'modules/pod-prune/scheduler.ts': ['recomputes the prunable set each tick and deletes pods by name; notifies nobody'],
  'modules/tenant-snapshots/scheduler.ts': ['both deletes are idempotent — a snapshot already gone is tolerated'],
  'modules/metrics/usage-reaper-scheduler.ts': ['the fold replaces the daily row and commits together with the delete of its source rows'],
  'modules/data-retention/scheduler.ts': ['age-bounded DELETEs'],
  'modules/notifications/retention/scheduler.ts': ['age- and expiry-bounded DELETEs'],
  'modules/tasks/retention.ts': ['one conditional UPDATE and one age-bounded DELETE'],
  'modules/backup-restore/cleanup-drafts-scheduler.ts': ['one age-bounded DELETE'],
  'modules/oidc/routes.ts': ['one expiry-bounded DELETE'],
  'modules/security-hardening/crowdsec-bouncer-heartbeat-scheduler.ts': [
    'one read of the decision list every 12 hours; whether the engine tracks that pull per calling address is not established, so each replica keeps its own registration alive',
  ],
  'modules/storage-lifecycle/scheduler.ts': ['orphan Secret sweep: deletes by name Secrets that are ownerless and over 12 hours old'],
  'app.ts': [
    'image-pull Secret reconcile: a Secret is recreated only when missing, under a fixed name whose second create is a handled conflict',
    'scheduled mail archive: dormant — never started while MAIL_ARCHIVE_ENABLED is false; when on, the run is claimed by a compare-and-swap on the last-run time',
    'mail migration orphan reconciler: one conditional UPDATE that matches nothing on a second run',
    'mail-task orphan reaper: serialised by an advisory transaction lock',
    'refresh-token prune: one age-bounded DELETE',
    'passkey challenge prune: expiry-bounded DELETEs',
    'image reap sweeper: due rows are claimed with DELETE … RETURNING',
    "start-up panel ingress sync: a retry, five attempts at most, of this process's own start-up reconcile",
  ],
};

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

/** The name a function is known by: its declaration, the variable or property it is assigned to. */
function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
}

function callsFunction(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && calleeName(n.expression) === name) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function containsAwait(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
  return found;
}

/** `while (!stopped)`, `while (running)`, `while (!signal.aborted)` — a loop that ends with the process, not with its work. */
function isRunFlag(e: ts.Expression): boolean {
  const inner = ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken ? e.operand : e;
  const name = ts.isIdentifier(inner) ? inner.text : ts.isPropertyAccessExpression(inner) ? inner.name.text : null;
  return name !== null && /stop|cancel|abort|shutdown|closed|running|alive/i.test(name);
}

/**
 * The recurring timers a source file starts, found in its syntax tree:
 *  - every call of `setInterval` (also `x.setInterval(…)`, and an import of it under another name);
 *  - every function that re-arms itself — a `setTimeout` inside the function,
 *    whose callback is that function or calls it (`schedule()` helpers included).
 *    A first run armed from outside the function is a delay, not a loop;
 *  - every `while` loop on a run flag (`while (!stopped)`) that awaits.
 * Not found: a loop spread over two functions that arm each other, and a
 * `for (;;)` — the ones in the code today are bounded waits and pagination.
 */
function recurringTimers(source: string, fileName = 'file.ts'): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const intervalNames = new Set(['setInterval']);
  const timeoutNames = new Set(['setTimeout']);
  for (const st of sf.statements) {
    const named = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const original = (el.propertyName ?? el.name).text;
      if (original === 'setInterval') intervalNames.add(el.name.text);
      if (original === 'setTimeout') timeoutNames.add(el.name.text);
    }
  }

  let intervals = 0;
  let flagLoops = 0;
  const selfArming = new Set<ts.Node>();
  const visit = (node: ts.Node, enclosing: ReadonlyArray<{ name: string; node: ts.Node }>): void => {
    const name = ts.isFunctionLike(node) ? functionName(node) : null;
    const inside = name ? [...enclosing, { name, node }] : enclosing;
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const callback = node.arguments[0];
      if (callee && intervalNames.has(callee)) intervals += 1;
      else if (callee && timeoutNames.has(callee) && callback) {
        for (const fn of inside) {
          const rearms = ts.isIdentifier(callback) ? callback.text === fn.name : callsFunction(callback, fn.name);
          if (rearms) selfArming.add(fn.node);
        }
      }
    }
    if ((ts.isWhileStatement(node) || ts.isDoStatement(node)) && isRunFlag(node.expression) && containsAwait(node.statement)) {
      flagLoops += 1;
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(sf, []);
  return intervals + selfArming.size + flagLoops;
}

/** Every platform-api source file (tests and the separate CLI process excluded) that starts a recurring timer. */
function filesWithTimers(dir: string = SRC, out: Map<string, number> = new Map()): Map<string, number> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== join(SRC, 'cli')) filesWithTimers(full, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const n = recurringTimers(readFileSync(full, 'utf8'), entry.name);
      if (n > 0) out.set(relative(SRC, full), n);
    }
  }
  return out;
}

const leasedTimers = (file: string): number => LEASED.filter((l) => l.file === file).reduce((n, l) => n + (l.timers ?? 1), 0);

describe('every recurring timer is leased, or runs on every replica for a stated reason', () => {
  const found = filesWithTimers();
  const classified = new Set([...LEASED.filter((l) => l.timers !== 0).map((l) => l.file), ...Object.keys(EVERY_REPLICA)]);

  it('finds the timers (a scan that finds none proves nothing)', () => {
    expect(found.size).toBeGreaterThan(80);
    expect(found.get('modules/backup-health/freshness-sweep.ts')).toBe(1);
    expect(found.get('modules/storage-lifecycle/scheduler.ts')).toBe(8);
  });

  it.each([...new Set([...found.keys(), ...classified])].sort())('%s accounts for each of its timers', (file) => {
    const timers = found.get(file) ?? 0;
    const accounted = leasedTimers(file) + (EVERY_REPLICA[file]?.length ?? 0);
    expect(
      { file, timers, accounted },
      `${file} starts ${timers} recurring timer(s) and accounts for ${accounted}. Put each new one behind `
      + 'withSchedulerLease and add it to LEASED — or, if it must run on every replica, give the reason in EVERY_REPLICA.',
    ).toEqual({ file, timers, accounted: timers });
  });

  it.each(LEASED)('$job ($file) runs behind its lease', ({ file, job }) => {
    // The job name as the lease call's own argument — not merely somewhere in
    // the file, where a comment or another job's lease would satisfy it.
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src).toMatch(new RegExp(`withSchedulerLease\\(\\s*[\\w.]+,\\s*'${job}'`));
  });

  // (The helper itself is exempt: it is where the function lives.)
  it.each(Object.keys(EVERY_REPLICA).filter((f) => f !== 'shared/scheduler-lease.ts' && !LEASED.some((l) => l.file === f)))(
    '%s takes no lease',
    (file) => {
      expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/withSchedulerLease\(/);
    },
  );

  it('the job names are distinct — two jobs sharing a lease would starve each other', () => {
    expect(new Set(LEASED.map((l) => l.job)).size).toBe(LEASED.length);
  });

  it('a graceful shutdown hands every lease to the remaining replicas', () => {
    expect(readFileSync(join(SRC, 'server.ts'), 'utf8')).toMatch(/releaseAllSchedulerLeases\(db\)/);
  });
});

describe('recurringTimers', () => {
  it('counts intervals, however they are named', () => {
    expect(recurringTimers('const t = setInterval(tick, 1000);')).toBe(1);
    expect(recurringTimers('const t = globalThis.setInterval(() => tick(), 1000);')).toBe(1);
    expect(recurringTimers("import { setInterval as every } from 'node:timers';\nevery(tick, 1000);")).toBe(1);
  });

  it('counts a function that re-arms itself, in each of its shapes, once', () => {
    expect(recurringTimers('timer = setTimeout(tick, D);\nconst tick = async () => { await work(); timer = setTimeout(tick, I); };')).toBe(1);
    expect(recurringTimers('const tick = async () => { await work(); setTimeout(tick, 60000); };\nvoid tick();')).toBe(1);
    expect(recurringTimers('async function loop() { await work(); setTimeout(() => void loop(), ms); }')).toBe(1);
    expect(recurringTimers('function scheduleNext() { setTimeout(async () => { await run(); scheduleNext(); }, 9); }')).toBe(1);
    expect(recurringTimers('const schedule = (ms: number): void => { timer = setTimeout(() => { run(); schedule(I); }, ms); };')).toBe(1);
    // Three re-arm sites in one function are one loop.
    expect(recurringTimers('const tick = async () => { if (a) { t = setTimeout(tick, I); return; } if (b) { t = setTimeout(tick, I); return; } t = setTimeout(tick, I); };')).toBe(1);
  });

  it('counts a loop that runs until the process stops', () => {
    expect(recurringTimers('async function run() { while (!stopped) { await work(); await sleep(1000); } }')).toBe(1);
    expect(recurringTimers('async function page() { while (cursor) { cursor = await next(cursor); } }')).toBe(0);
  });

  it('does not count a delay, a first run, a timeout, or a timer that is only described', () => {
    expect(recurringTimers('await new Promise((resolve) => setTimeout(resolve, 5));')).toBe(0);
    expect(recurringTimers('const kick = setTimeout(runOnce, 120_000);')).toBe(0);
    expect(recurringTimers('function start() { const tick = () => work(); const startup = setTimeout(tick, 9); }')).toBe(0);
    expect(recurringTimers('const guard = setTimeout(() => controller.abort(), 30_000);')).toBe(0);
    expect(recurringTimers("// it used to be a bare setInterval(fn, DAY)\n/** setInterval(x, 1) */\nconst s = 'setInterval(';")).toBe(0);
    expect(recurringTimers('const schedule = row.cronExpression;')).toBe(0);
  });
});
