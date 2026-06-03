/**
 * Production wiring for `platform-ops host-config` (ADR-045 W10, amended —
 * host-side convergence). platform-ops runs as root on the host, so it reads +
 * writes /proc/sys NATIVELY (it's already in the host mount + net namespaces);
 * no privileged pod, no caps. The desired policy is read from the cluster's
 * host-config-desired ConfigMap via kubeconfig.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  convergeSysctls,
  normalizeSysctl,
  sysctlAllowed,
  sysctlKeyToRelPath,
  MAX_SYSCTL_VALUE_LEN,
} from './sysctls.js';
import type { ConvergeResult, HostConfigDeps, HostConfigOptions, SysctlSpec } from './types.js';

export type { ConvergeResult, HostConfigOptions } from './types.js';

const DESIRED_CM = 'host-config-desired';
const DESIRED_NS = 'platform-system';
const PROC_SYS = '/proc/sys';

/** Parse sysctl.conf-style `key = value` lines (matches the Go observe parser). */
export function parseSysctls(raw: string): SysctlSpec[] {
  const out: SysctlSpec[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim();
    if (key) out.push({ key, value });
  }
  return out;
}

/** Resolve a sysctl key to its absolute /proc/sys path, with containment. */
function procSysPath(key: string): string | null {
  const rel = sysctlKeyToRelPath(key);
  if (!rel) return null;
  const full = join(PROC_SYS, rel);
  if (full !== PROC_SYS && !full.startsWith(PROC_SYS + '/')) return null;
  return full;
}

function readSysctl(key: string): string | null {
  const full = procSysPath(key);
  if (!full) return null;
  try {
    return normalizeSysctl(readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

// The ONLY host-mutating function. Re-validates the allow-list + deny-list + path
// containment + value length on EVERY write — the second, independent gate behind
// convergeSysctls's allow-list check, so a bug in the loop can never escalate into
// a deny-listed or out-of-bounds host write.
function writeSysctl(key: string, value: string): void {
  if (!sysctlAllowed(key)) throw new Error(`refusing to write non-allow-listed sysctl ${key}`);
  if (value.length > MAX_SYSCTL_VALUE_LEN) throw new Error(`refusing oversize sysctl value (${value.length} bytes) for ${key}`);
  const full = procSysPath(key);
  if (!full) throw new Error(`refusing unsafe sysctl path for ${key}`);
  writeFileSync(full, value + '\n');
}

async function readDesired(env: NodeJS.ProcessEnv): Promise<{ sysctls: SysctlSpec[]; mode: string } | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: DESIRED_CM,
      namespace: DESIRED_NS,
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    return {
      sysctls: parseSysctls(cm.data?.['sysctls'] ?? ''),
      mode: (cm.data?.['mode'] ?? '').trim(),
    };
  } catch {
    return null; // ConfigMap absent / cluster unreachable → nothing to converge
  }
}

export function realHostConfigDeps(env: NodeJS.ProcessEnv): HostConfigDeps {
  return {
    readDesired: () => readDesired(env),
    readSysctl,
    writeSysctl,
  };
}

export interface HostConfigOps {
  run: (opts: HostConfigOptions) => Promise<ConvergeResult>;
}

export function realHostConfigOps(env: NodeJS.ProcessEnv): HostConfigOps {
  const deps = realHostConfigDeps(env);
  return {
    async run(opts) {
      const desired = await deps.readDesired();
      if (!desired) return convergeSysctls(null, false, deps);
      // Two gates: the desired policy's mode must be "enforce" (opt-in), AND the
      // operator hasn't forced --dry-run. --apply forces enforce (manual run).
      const enforcing = opts.apply || (!opts.dryRun && desired.mode.toLowerCase() === 'enforce');
      return convergeSysctls(desired.sysctls, enforcing, deps);
    },
  };
}
