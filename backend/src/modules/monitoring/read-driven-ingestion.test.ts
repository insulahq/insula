/**
 * Read-driven ingestion is a contract between two places that change
 * independently: what vmsingle stores (k8s/base/monitoring/read-driven-relabel.yaml
 * + streamaggr-config.yaml) and what the backend queries. When they drift, a
 * query silently finds nothing — no error, an empty panel or a rule that can
 * never fire. This test fails the build in both directions:
 *
 *   - a metric family the backend queries is not in the READ allowlist, or a
 *     label a reader filters on is aggregated away;
 *   - the allowlist keeps a family nothing reads (the policy exists to stop
 *     storing those) — vmsingle's own health metrics are the one declared
 *     exception, scoped to its own job.
 *
 * "The backend queries" = every non-test source file that imports the
 * vmsingle client, plus the modules those files import directly (where rule
 * and PromQL-builder definitions live).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');
const REPO = resolve(SRC, '../..');
const MONITORING = join(REPO, 'k8s/base/monitoring');
const FULL_COMPONENT = join(REPO, 'k8s/components/monitoring-full-metrics/kustomization.yaml');

/** Metric-family prefixes of the scrape jobs in scrape-config.yaml. */
const METRIC_TOKEN = /\b(?:up|(?:container|machine|kubelet|traefik|certmanager|longhorn|cnpg|coredns|gotk|controller_runtime|platform)_[a-z0-9_]+)\b/g;

interface RelabelRule { readonly action: string; readonly if?: string | string[] }
interface AggrRule { readonly match: string; readonly by: string[]; readonly [k: string]: unknown }

function configMapData(file: string, key: string): string {
  const doc = yaml.load(readFileSync(file, 'utf8')) as { data: Record<string, string> };
  return doc.data[key];
}

function namesIn(selector: string): string[] {
  const m = selector.match(/__name__=~"([^"]+)"/);
  if (!m) throw new Error(`selector has no __name__ regex: ${selector}`);
  // Literal names only: a regex metacharacter here would make the guard's
  // set comparison meaningless.
  expect(m[1]).toMatch(/^[a-z0-9_|]+$/);
  return m[1].split('|');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sources = walk(SRC).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts'));
const VM_CLIENT_IMPORT = /from\s+['"][^'"]*vm-client(?:\.js)?['"]/;
const RELATIVE_IMPORT = /from\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Importers of the vmsingle client, plus the files they import from their OWN
 * feature directory — that is where the rules and PromQL builders live
 * (monitoring/rules.ts, traffic/promql.ts). Imports reaching outside the
 * feature (db/schema.ts, auth, notifications) are not queries, and their table
 * and cookie names would read as metric families.
 */
function readerFiles(): string[] {
  const importers = sources.filter((p) => VM_CLIENT_IMPORT.test(readFileSync(p, 'utf8')));
  const files = new Set(importers);
  for (const f of importers) {
    for (const [, spec] of readFileSync(f, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(f), spec.replace(/\.js$/, '.ts'));
      if (dirname(target) === dirname(f) && sources.includes(target) && !target.endsWith('vm-client.ts')) files.add(target);
    }
  }
  return [...files];
}

/** Source without comments: prose naming a metric ("NOT controller_runtime_…") is not a read. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function readNamesByFile(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of readerFiles()) {
    for (const [name] of code(f).matchAll(METRIC_TOKEN)) {
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(f.slice(SRC.length + 1));
    }
  }
  return out;
}

const relabel = yaml.load(configMapData(join(MONITORING, 'read-driven-relabel.yaml'), 'relabel.yml')) as RelabelRule[];
const keep = relabel[0];
const [readSelector, diagSelector] = (keep.if ?? []) as string[];
const READ = new Set(namesIn(readSelector));
const DIAGNOSTIC = new Set(namesIn(diagSelector));
const readers = readNamesByFile();

describe('read-driven ingestion: the allowlist matches the backend readers', () => {
  it('starts with a single keep rule of READ + vmsingle-scoped DIAGNOSTIC selectors', () => {
    expect(keep.action).toBe('keep');
    expect(keep.if).toHaveLength(2);
    expect(diagSelector).toContain('job="vmsingle"');
    expect(readSelector).not.toContain('job=');
  });

  it('finds the readers it is meant to scan (the scan itself is not broken)', () => {
    const files = readerFiles().map((f) => f.slice(SRC.length + 1));
    expect(files).toEqual(expect.arrayContaining([
      'modules/monitoring/rules.ts',
      'modules/monitoring/routes.ts',
      'modules/traffic/promql.ts',
      'modules/bandwidth/meter.ts',
    ]));
    expect(readers.size).toBeGreaterThan(20);
  });

  it('keeps every metric family the backend queries', () => {
    const missing = [...readers.keys()].filter((n) => !READ.has(n));
    expect(missing.map((n) => `${n} (read in ${[...readers.get(n)!].join(', ')})`)).toEqual([]);
  });

  it('keeps nothing that no reader queries', () => {
    expect([...READ].filter((n) => !readers.has(n))).toEqual([]);
  });

  it('keeps no diagnostic family that is also read (it would belong in READ)', () => {
    expect([...DIAGNOSTIC].filter((n) => READ.has(n))).toEqual([]);
  });
});

describe('read-driven ingestion: dimensions the readers need survive', () => {
  const drops = (relabel[1]?.if ?? []) as string[];

  it('drops per-container CPU/memory/OOM series only outside what the rules read', () => {
    expect(relabel[1].action).toBe('drop');
    expect(drops).toContain('container_cpu_usage_seconds_total{id!="/"}');
    for (const d of drops) expect(d).toContain('id!="/"'); // the node-level series always stays
  });

  it('keeps OOM series for exactly the namespaces the system-OOM rule reads', () => {
    const rules = readFileSync(join(SRC, 'modules/monitoring/rules.ts'), 'utf8');
    const ruleNs = rules.match(/container_oom_events_total\{namespace=~"([^"]+)"/)?.[1];
    const keptNs = drops.find((d) => d.startsWith('container_oom_events_total'))?.match(/namespace!~"([^"]+)"/)?.[1];
    expect(ruleNs).toBeTruthy();
    expect(keptNs).toBe(ruleNs);
  });

  it('aggregates no counter away from a label a reader selects on', () => {
    const aggr = yaml.load(configMapData(join(MONITORING, 'streamaggr-config.yaml'), 'streamaggr.yaml')) as AggrRule[];
    const problems: string[] = [];
    for (const rule of aggr) {
      const allowed = new Set([...rule.by, '__name__']);
      for (const f of readerFiles()) {
        const text = code(f);
        const re = new RegExp(`${rule.match}\\{([^}]*)\\}`, 'g');
        for (const [, body] of text.matchAll(re)) {
          for (const [, label] of body.matchAll(/([a-z_]+)\s*(?:=~|!~|!=|=)/g)) {
            if (!allowed.has(label)) problems.push(`${rule.match}: '${label}' in ${f.slice(SRC.length + 1)} is not in by: [${rule.by}]`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('monitoring-full-metrics component', () => {
  const component = yaml.load(readFileSync(FULL_COMPONENT, 'utf8')) as { patches: Array<{ patch: string }> };
  const patched = (name: string) => component.patches
    .map((p) => yaml.load(p.patch) as { metadata: { name: string }; data: Record<string, string> })
    .find((d) => d.metadata.name === name)!;

  it('empties the read-driven relabel config', () => {
    expect(yaml.load(patched('vmsingle-read-driven').data['relabel.yml'])).toEqual([]);
  });

  it('keeps exactly the base latency-histogram aggregation rules', () => {
    const base = yaml.load(configMapData(join(MONITORING, 'streamaggr-config.yaml'), 'streamaggr.yaml')) as AggrRule[];
    const full = yaml.load(patched('vmsingle-streamaggr-config').data['streamaggr.yaml']) as AggrRule[];
    expect(full).toEqual(base.filter((r) => r.match.endsWith('_bucket')));
  });
});
