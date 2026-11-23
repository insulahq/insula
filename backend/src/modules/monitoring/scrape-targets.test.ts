/**
 * Every pod-discovery scrape job in k8s/base/monitoring/scrape-config.yaml must
 * produce ONE target per pod. Pod discovery yields a target per declared
 * container port; a job that rewrites `__address__` to its metrics port turns a
 * three-port pod into three identical targets, and vmsingle logs "skipping
 * duplicate scrape target" for each of them on every discovery pass — on
 * production that was every line of its log, which then held only minutes.
 * So each job keeps its metrics port instead, and never rewrites the address.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');

interface Relabel {
  readonly source_labels?: string[];
  readonly target_label?: string;
  readonly regex?: string;
  readonly action?: string;
}
interface ScrapeJob {
  readonly job_name: string;
  readonly kubernetes_sd_configs?: Array<{ role: string }>;
  readonly relabel_configs?: Relabel[];
}

const configMap = yaml.load(repoFile('k8s/base/monitoring/scrape-config.yaml')) as { data: Record<string, string> };
const jobs = (yaml.load(configMap.data['prometheus.yml']) as { scrape_configs: ScrapeJob[] }).scrape_configs;
const podJobs = jobs.filter((j) => j.kubernetes_sd_configs?.some((sd) => sd.role === 'pod'));

const PORT_LABEL = '__meta_kubernetes_pod_container_port_number';
const keptPort = (job: ScrapeJob): string | undefined => job.relabel_configs
  ?.find((r) => r.action === 'keep' && r.source_labels?.length === 1 && r.source_labels[0] === PORT_LABEL)
  ?.regex;

describe('pod scrape jobs — one target per pod', () => {
  it('finds the pod jobs', () => {
    expect(podJobs.map((j) => j.job_name)).toEqual(
      expect.arrayContaining(['traefik', 'cert-manager', 'longhorn', 'flux', 'cnpg', 'platform-api', 'coredns']),
    );
  });

  it.each(podJobs.map((j) => [j.job_name, j] as const))('%s keeps a single container port', (_name, job) => {
    expect(keptPort(job)).toMatch(/^\d+$/);
  });

  it('keeps each component\'s metrics port', () => {
    // As each component declares it in its pod spec (checked on a live cluster).
    expect(Object.fromEntries(podJobs.map((j) => [j.job_name, keptPort(j)]))).toEqual({
      traefik: '9100',
      'cert-manager': '9402',
      longhorn: '9500',
      flux: '8080',
      cnpg: '9187',
      'platform-api': '9090',
      coredns: '9153',
    });
  });

  it.each(podJobs.map((j) => [j.job_name, j] as const))('%s never rewrites the target address', (_name, job) => {
    expect((job.relabel_configs ?? []).filter((r) => r.target_label === '__address__')).toEqual([]);
  });

  it('platform-api declares the port its job keeps, so the target is not dropped', () => {
    const port = keptPort(podJobs.find((j) => j.job_name === 'platform-api')!);
    const docs = yaml.loadAll(repoFile('k8s/base/backend-deployment.yaml')) as Array<{
      kind?: string;
      metadata?: { name?: string };
      spec?: { template?: { spec?: { containers?: Array<{ ports?: Array<{ containerPort: number }> }> } } };
    } | null>;
    const deployment = docs.find((d) => d?.kind === 'Deployment' && d.metadata?.name === 'platform-api');
    const declared = (deployment?.spec?.template?.spec?.containers ?? [])
      .flatMap((c) => (c.ports ?? []).map((p) => String(p.containerPort)));
    expect(declared).toContain(port);
  });
});
