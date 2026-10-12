/**
 * A leased job's work is started by its timer — and by nothing else, unless
 * that other start takes the job's run lock or is known to be harmless.
 *
 * The sticky lease (scheduler-lease.ts) keeps a job's TIMER on one replica. A
 * route that calls the same function — to apply a change at once, or for a
 * "run now" button — is served by whichever replica got the request, and runs
 * beside the timer's run on another replica or in the same process. That is
 * the double run the lease was added to stop, by another door: the ingress
 * arguments patched by position from a snapshot the other run has changed, the
 * WAF or the backup proxy rolled twice, one alert sent by both.
 *
 * So this test finds those other starts itself, by parsing the source. For
 * every sticky lease it takes the functions the lease's callback calls — the
 * job's entry points — and then every other file that calls one of them. Each
 * such call must be in STARTED_ELSEWHERE: `'run-lock'` (the call then has to
 * be made under the job's run lock, see shared/exclusive-run.ts), or the
 * reason it takes none — an overlap is harmless, or the call is a different
 * operation whose own exclusion is someone else's to provide, in which case
 * the entry says what is left open. A new caller fails here until it is
 * classified.
 *
 * Not found: a job whose callback only calls a function private to its file,
 * when that function in turn calls something a route calls too. Following
 * private functions further was tried and drowns the result in helpers (a
 * hundred functions, most of them reads); the entry points are where a whole
 * second run of a job comes from.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

/**
 * `<job> <module>#<function> <- <calling file>` → `'run-lock'`, or why the
 * call takes none. Keys are exactly what the scan prints.
 */
const STARTED_ELSEWHERE: Readonly<Record<string, string>> = {
  // ── Reconcilers a route starts after it has changed what they read ──
  'backup-rclone-shim modules/backup-rclone-shim/reconciler.ts#reconcileBackupRcloneShim <- modules/backup-rclone-shim/apply-assignment.ts': 'run-lock',
  'cluster-trusted-proxies modules/cluster-trusted-proxies/scheduler.ts#runReconcileExclusive <- modules/cluster-trusted-proxies/routes.ts': 'run-lock',
  'waf-rule-exclusions modules/waf-rule-exclusions/scheduler.ts#runWafExclusionReconcile <- modules/ingress-routes/routes.ts': 'run-lock',
  'waf-rule-exclusions modules/waf-rule-exclusions/scheduler.ts#runWafExclusionReconcile <- modules/security-hardening/routes.ts': 'run-lock',
  'stalwart-domain-reconciler modules/mail-admin/stalwart-domain-reconciler.ts#runStalwartDomainReconcile <- modules/mail-admin/migration.ts': 'run-lock',
  'stalwart-domain-reconciler modules/mail-admin/stalwart-domain-reconciler.ts#runStalwartDomainReconcile <- modules/mail-admin/routes.ts': 'run-lock',
  'stalwart-domain-reconciler modules/mail-admin/stalwart-domain-reconciler.ts#runStalwartDomainReconcile <- modules/platform-domain/service.ts': 'run-lock',
  'stalwart-domain-reconciler modules/mail-admin/stalwart-domain-reconciler.ts#runStalwartDomainReconcile <- modules/platform-urls/routes.ts': 'run-lock',
  'stalwart-domain-reconciler modules/mail-admin/stalwart-domain-reconciler.ts#runStalwartDomainReconcile <- modules/webmail-settings/routes.ts': 'run-lock',
  'storage-policy-advisor modules/platform-storage-policy/service.ts#applyPolicy <- modules/platform-storage-policy/routes.ts': 'run-lock',

  // ── "Run now" buttons ──
  'namespace-integrity modules/namespace-integrity/service.ts#sweepFleetIntegrity <- modules/namespace-integrity/routes.ts': 'run-lock',
  'node-health-monitor modules/node-health/scheduler.ts#reconcileNodeHealth <- modules/node-health/routes.ts': 'run-lock',
  'subscription-expiry modules/subscriptions/expiry-checker.ts#suspendExpiredTenants <- modules/subscriptions/routes.ts': 'run-lock',
  'crowdsec-bouncer-prune modules/security-hardening/crowdsec.ts#pruneStaleBouncers <- modules/security-hardening/routes.ts': 'run-lock',
  'daily-image-prune modules/storage/service.ts#purgeUnusedImages <- modules/storage/routes.ts': 'run-lock',
  'storage-auto-archive modules/tenant-lifecycle/automation/real.ts#sweepTenantsOnce <- modules/tenant-lifecycle/automation/routes.ts': 'run-lock',
  'restic-retention modules/tenant-bundles/restic-retention.ts#runResticRetentionSweep <- modules/tenant-bundles/routes.ts':
    'takes the sweep\'s own run lock (RESTIC_SWEEP_RUN_LOCK), which the scheduled sweep takes too; a dry run changes nothing and may overlap',
  'dns-route-drift-scan modules/dns-apex-drift/service.ts#scanApexDrift <- modules/dns-apex-drift/routes.ts':
    'a scan reads the zones and stores its report; two at once store the same findings, and nothing is sent',
  'mailbox-usage-sync modules/mail-stats/service.ts#reconcileMailboxUsage <- modules/mail-stats/routes.ts':
    'writes each mailbox\'s measured size, the same numbers from both runs; the over-quota check that notifies is not part of this call',
  'deployment-status-reconcile modules/deployments/status-reconciler.ts#reconcileDeploymentStatuses <- modules/deployments/routes.ts':
    'copies each deployment\'s state from the cluster into its row, the same values from both runs; it sends nothing',
  'waf-log-scraper modules/ingress-routes/waf-log-scraper.ts#scrapeWafLogs <- modules/security-hardening/routes.ts':
    'an event with a ModSecurity unique id is stored once, whoever read it. The rare event without one is stored again by '
    + 'every read of its window — which a refresh is, overlapping the tick or not — so a lock would change nothing',

  // ── Reads ──
  'node-subsystem-health modules/cluster-health/service.ts#collectNodeSubsystemHealth <- modules/cluster-health/routes.ts': 'a read: the page shows the current state',
  'node-subsystem-health modules/node-health/join-grace.ts#describeSuppression <- modules/monitoring/evaluator.ts': 'a read: words for a suppression',
  'node-subsystem-health modules/node-health/join-grace.ts#describeSuppression <- modules/node-health/fast-down-watch.ts': 'a read: words for a suppression',
  'node-subsystem-health modules/node-health/join-grace.ts#describeSuppression <- modules/node-health/scheduler.ts': 'a read: words for a suppression',
  'node-subsystem-health modules/node-health/join-grace.ts#loadJoinGrace <- modules/node-health/scheduler.ts': 'a read: the join-grace settings',
  'storage-audit modules/storage-lifecycle/service.ts#storageAuditReport <- modules/storage-lifecycle/routes.ts': 'a read: the report is computed and returned',
  'storage-capacity-watch modules/platform-storage-policy/capacity-reconciler.ts#readClusterCapacity <- modules/platform-storage-policy/routes.ts': 'a read: capacity for the page',
  'storage-policy-advisor modules/platform-storage-policy/service.ts#getPolicy <- modules/platform-storage-policy/routes.ts': 'a read: the saved policy',
  'storage-policy-advisor modules/platform-storage-policy/service.ts#readClusterState <- modules/platform-storage-policy/routes.ts': 'a read: cluster state for the page',
  'storage-policy-advisor modules/platform-storage-policy/service.ts#readClusterState <- modules/platform-storage-policy/runs.ts': 'a read: cluster state for the convergence watcher',
};

/**
 * Called inside leases, but not a job's work: building a client, the lease
 * helpers themselves, sending one notification.
 */
const NOT_WORK: ReadonlySet<string> = new Set([
  'modules/k8s-provisioner/k8s-client.ts#createK8sClients',
  'shared/scheduler-lease.ts#withSchedulerLease',
  'shared/exclusive-run.ts#runExclusive',
  'modules/notifications/events.ts#notifyAdminOperationalEvent',
]);

interface Binding { readonly module: string; readonly original: string }

interface Parsed {
  readonly rel: string;
  readonly sf: ts.SourceFile;
  /** Local name → the module and export it is bound to (static and awaited imports). */
  readonly imports: ReadonlyMap<string, Binding>;
  /** Local name of a whole imported module → that module. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** Functions declared in the file, by the name they are known by. */
  readonly locals: ReadonlyMap<string, readonly ts.Node[]>;
  readonly exported: ReadonlySet<string>;
}

/** `./x.js` as written in `fromRel` → the source file it names, relative to SRC. Null for a package. */
function resolveModule(fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return join(dirname(fromRel), specifier).replace(/\.js$/, '.ts');
}

function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
}

/** The module an `import('./x.js')`, awaited or not, names — or null. */
function dynamicImportModule(fromRel: string, e: ts.Expression | undefined): string | null {
  const inner = e && ts.isAwaitExpression(e) ? e.expression : e;
  if (!inner || !ts.isCallExpression(inner) || inner.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const arg = inner.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? resolveModule(fromRel, arg.text) : null;
}

function parse(rel: string, source: string): Parsed {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, Binding>();
  const namespaces = new Map<string, string>();
  const locals = new Map<string, ts.Node[]>();
  const exported = new Set<string>();
  const isExported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const module = resolveModule(rel, node.moduleSpecifier.text);
      const named = node.importClause?.namedBindings;
      if (module && named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (!el.isTypeOnly) imports.set(el.name.text, { module, original: (el.propertyName ?? el.name).text });
        }
      }
      if (module && named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, module);
    }
    if (ts.isVariableDeclaration(node)) {
      const module = dynamicImportModule(rel, node.initializer);
      if (module && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const original = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
          imports.set(el.name.text, { module, original });
        }
      }
      if (module && ts.isIdentifier(node.name)) namespaces.set(node.name.text, module);
    }
    if (ts.isFunctionLike(node)) {
      const name = functionName(node);
      if (name) locals.set(name, [...(locals.get(name) ?? []), node]);
    }
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) exported.add(node.name.text);
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) exported.add(d.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rel, sf, imports, namespaces, locals, exported };
}

function sources(dir: string = SRC, out: Parsed[] = []): Parsed[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(parse(relative(SRC, full), readFileSync(full, 'utf8')));
    }
  }
  return out;
}

/** What a call's callee is bound to outside the file, if anything. */
function bindingOf(file: Parsed, callee: ts.Expression): Binding | null {
  if (ts.isIdentifier(callee)) {
    const imported = file.imports.get(callee.text);
    if (imported) return imported;
    return file.exported.has(callee.text) ? { module: file.rel, original: callee.text } : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const module = file.namespaces.get(callee.expression.text);
    return module ? { module, original: callee.name.text } : null;
  }
  return null;
}

const key = (b: Binding): string => `${b.module}#${b.original}`;

interface StickyLease { readonly file: string; readonly job: string; readonly work: ReadonlySet<string> }

/**
 * Every sticky lease in the source, with the functions its callback calls
 * that another file could call too: imported ones, and the file's own
 * exports. A callback given by name (`…, runOnce)`) is read where it is
 * declared.
 */
function stickyLeases(files: readonly Parsed[]): StickyLease[] {
  const out: StickyLease[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withSchedulerLease') {
        const [, job, , fn, opts] = node.arguments;
        const releases = opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
          ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'release' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
        if (job && ts.isStringLiteralLike(job) && fn && !releases) {
          const work = new Set<string>();
          const collect = (n: ts.Node): void => {
            const bound = ts.isCallExpression(n) ? bindingOf(file, n.expression) : null;
            if (bound && !NOT_WORK.has(key(bound))) work.add(key(bound));
            ts.forEachChild(n, collect);
          };
          if (ts.isIdentifier(fn)) {
            // `withSchedulerLease(db, 'job', ttl, runOnce)` — the callback is a named function of this file.
            const bound = bindingOf(file, fn);
            if (bound) work.add(key(bound));
            for (const local of file.locals.get(fn.text) ?? []) collect(local);
          } else {
            collect(fn);
          }
          out.push({ file: file.rel, job: job.text, work });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sf);
  }
  return out;
}

/** Every call, outside the lease's own file, of a function a leased job's work calls. */
function startsElsewhere(files: readonly Parsed[]): string[] {
  const found = new Set<string>();
  const leases = stickyLeases(files);
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const bound = bindingOf(file, node.expression);
        if (bound && bound.module !== file.rel) {
          for (const lease of leases) {
            if (lease.file !== file.rel && lease.work.has(key(bound))) found.add(`${lease.job} ${key(bound)} <- ${file.rel}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sf);
  }
  return [...found].sort();
}

/** True when `node` contains `runExclusive(…, '<job>', …)` or `runExclusiveOrBusy(…, '<job>', …)`. */
function takesRunLock(node: ts.Node, job: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^runExclusive(OrBusy)?$/.test(n.expression.text)) {
      const arg = n.arguments[1];
      if (arg && ts.isStringLiteralLike(arg) && arg.text === job) { found = true; return; }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

describe('a leased job is started outside its timer only under its run lock, or for a stated reason', () => {
  const files = sources();
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const found = startsElsewhere(files);

  it('finds the leases and their other callers (a scan that finds none proves nothing)', () => {
    expect(stickyLeases(files).length).toBeGreaterThan(50);
    expect(found).toContain('backup-rclone-shim modules/backup-rclone-shim/reconciler.ts#reconcileBackupRcloneShim <- modules/backup-rclone-shim/apply-assignment.ts');
    // Through `import * as service` …
    expect(found).toContain('dns-route-drift-scan modules/dns-apex-drift/service.ts#scanApexDrift <- modules/dns-apex-drift/routes.ts');
    // … through `await import()` on both sides …
    expect(found).toContain('namespace-integrity modules/namespace-integrity/service.ts#sweepFleetIntegrity <- modules/namespace-integrity/routes.ts');
    // … and a callback given by name.
    expect(found).toContain('waf-log-scraper modules/ingress-routes/waf-log-scraper.ts#scrapeWafLogs <- modules/security-hardening/routes.ts');
  });

  it.each([...new Set([...found, ...Object.keys(STARTED_ELSEWHERE)])].sort())('%s', (entry) => {
    expect(found, `${entry} is listed in STARTED_ELSEWHERE but the scan no longer finds it — remove the entry`).toContain(entry);
    const verdict = STARTED_ELSEWHERE[entry];
    expect(
      verdict,
      `${entry}: this file starts a leased job's work outside its timer. Run it through runExclusive / `
      + "runExclusiveOrBusy (shared/exclusive-run.ts) and list it as 'run-lock' — or give the reason an overlap is harmless.",
    ).toBeTruthy();
    if (verdict !== 'run-lock') return;

    // The lock is taken where the call is made, or inside the function called
    // (a wrapper such as runWafExclusionReconcile).
    const [job, target, , caller] = entry.split(' ');
    const [module, name] = target!.split('#');
    const wrapper = (byRel.get(module!)?.locals.get(name!) ?? []).some((fn) => takesRunLock(fn, job!));
    const atCall = takesRunLock(byRel.get(caller!)!.sf, job!);
    expect(
      wrapper || atCall,
      `${entry} is listed as 'run-lock', but neither ${name} nor ${caller} calls runExclusive(…, '${job}', …)`,
    ).toBe(true);
  });

  it.each(Object.entries(STARTED_ELSEWHERE).filter(([, v]) => v === 'run-lock').map(([entry]) => entry.split(' ')[0]!)
    .filter((job, i, all) => all.indexOf(job) === i))('%s: the timer takes the run lock too', (job) => {
    // A lock only one side takes excludes nothing.
    const lease = stickyLeases(files).find((l) => l.job === job)!;
    const file = byRel.get(lease.file)!;
    expect(takesRunLock(file.sf, job), `${lease.file} leases '${job}' but never calls runExclusive(…, '${job}', …)`).toBe(true);
  });
});

describe('the scan', () => {
  const scan = (srcs: Record<string, string>): string[] =>
    startsElsewhere(Object.entries(srcs).map(([rel, source]) => parse(rel, source)));
  const scheduler = `
    import { withSchedulerLease } from '../../shared/scheduler-lease.js';
    import { reconcile } from './reconciler.js';
    export function start(db) { setInterval(() => withSchedulerLease(db, 'job', 1000, () => reconcile(db)), 1000); }`;

  it('finds a second caller by static import, awaited import and namespace import', () => {
    expect(scan({
      'modules/x/scheduler.ts': scheduler,
      'modules/x/routes.ts': "import { reconcile } from './reconciler.js'; export const h = (db) => reconcile(db);",
      'modules/y/routes.ts': "export const h = async (db) => { const { reconcile } = await import('../x/reconciler.js'); return reconcile(db); };",
      'modules/z/routes.ts': "import * as r from '../x/reconciler.js'; export const h = (db) => r.reconcile(db);",
    })).toEqual([
      'job modules/x/reconciler.ts#reconcile <- modules/x/routes.ts',
      'job modules/x/reconciler.ts#reconcile <- modules/y/routes.ts',
      'job modules/x/reconciler.ts#reconcile <- modules/z/routes.ts',
    ]);
  });

  it('does not confuse a function of the same name from another module', () => {
    expect(scan({
      'modules/x/scheduler.ts': scheduler,
      'modules/y/routes.ts': "import { reconcile } from './reconciler.js'; export const h = (db) => reconcile(db);",
    })).toEqual([]);
  });

  it('leaves a run lock out: a lease that releases is not a timer\'s lease', () => {
    expect(scan({
      'modules/x/scheduler.ts': scheduler.replace('() => reconcile(db))', '() => reconcile(db), { release: true })'),
      'modules/x/routes.ts': "import { reconcile } from './reconciler.js'; export const h = (db) => reconcile(db);",
    })).toEqual([]);
  });

  it('sees whether a call is made under the run lock', () => {
    const locked = parse('a.ts', "export const h = (db) => runExclusiveOrBusy(db, 'job', 'A job', () => reconcile(db));");
    expect(takesRunLock(locked.sf, 'job')).toBe(true);
    expect(takesRunLock(locked.sf, 'other-job')).toBe(false);
    expect(takesRunLock(parse('b.ts', 'export const h = (db) => reconcile(db);').sf, 'job')).toBe(false);
  });
});
