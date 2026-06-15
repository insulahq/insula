/**
 * `platform-ops backup target …` — manage backup targets + class bindings from a
 * node, without minting an admin JWT and hand-crafting REST calls. The actual
 * work runs IN the platform-api pod (backend/src/cli/backup-target.ts) so it has
 * DATABASE_URL + PLATFORM_ENCRYPTION_KEY + the in-cluster reconcilers; this
 * host-side wrapper just routes args + renders the pod's JSON for a terminal.
 */
import type { Deps } from './deps.js';

interface ConfigRow {
  id: string;
  name?: string;
  storageType?: string;
  s3Bucket?: string | null;
  s3Prefix?: string | null;
  cifsShare?: string | null;
  sshHost?: string | null;
  active?: boolean;
  enabled?: number;
}
interface Assignment {
  backupClass: string;
  targetId: string;
}

function renderList(json: unknown, deps: Deps): void {
  const data = json as { configs?: ConfigRow[]; assignments?: Assignment[] };
  const configs = data.configs ?? [];
  const assignments = data.assignments ?? [];
  const byTarget = new Map<string, string[]>();
  for (const a of assignments) {
    byTarget.set(a.targetId, [...(byTarget.get(a.targetId) ?? []), a.backupClass]);
  }
  if (configs.length === 0) {
    deps.out('No backup targets configured.');
  } else {
    deps.out('Backup targets:');
    for (const c of configs) {
      const where = c.s3Bucket ? `${c.s3Bucket}/${c.s3Prefix ?? ''}` : c.cifsShare ?? c.sshHost ?? '';
      const classes = (byTarget.get(c.id) ?? []).join(',') || '—';
      deps.out(
        `  ${c.id}  ${(c.name ?? '').padEnd(26)} ${(c.storageType ?? '').padEnd(5)} ${where}  [classes: ${classes}]${c.active ? '  ACTIVE' : ''}`,
      );
    }
  }
  const unbound = (['system', 'tenant', 'mail'] as const).filter((cl) => !assignments.some((a) => a.backupClass === cl));
  if (unbound.length) deps.out(`Unbound classes: ${unbound.join(', ')}`);
}

function renderResult(json: unknown, deps: Deps): void {
  const j = json as Record<string, unknown>;
  if (j.unbound) deps.out(`Unbound class '${j.backupClass}'.`);
  else if (j.backupClass && j.targetId) deps.out(`Bound class '${j.backupClass}' → target ${j.targetId}.${j.note ? ` (${j.note})` : ''}`);
  else if (j.id && j.name !== undefined) deps.out(`Created backup target ${j.id} (${j.name}).`);
  else if (j.id) deps.out(`Done: ${j.id}.`);
  else if (j.result) {
    const res = j.result as { ok?: boolean; latencyMs?: number; error?: { code?: string; message?: string } };
    deps.out(res.ok ? `Connection OK (${res.latencyMs ?? '?'}ms).` : `Connection FAILED: ${res.error?.code ?? ''} ${res.error?.message ?? ''}`.trim());
  } else deps.out(JSON.stringify(j));
}

async function run(
  entrypointArgs: string[],
  stdin: string | undefined,
  deps: Deps,
  json: boolean,
  render: (j: unknown, d: Deps) => void,
): Promise<number> {
  const r = await deps.backupTarget(entrypointArgs, stdin);
  if (!r.ok) {
    deps.err(`backup target: ${r.detail ?? 'failed'}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify(r.json));
  } else {
    render(r.json, deps);
  }
  // `test` reports a failed probe via ok:false in the JSON but a 0 exec exit;
  // surface that as a non-zero CLI exit so scripts can gate on it.
  const j = r.json as { ok?: boolean } | undefined;
  return j && j.ok === false ? 1 : 0;
}

function usage(deps: Deps, form: string): number {
  deps.err(`usage: platform-ops backup target ${form}`);
  return 2;
}

/**
 * `backup key-status` — show the BACKUP_TARGET_KEY fingerprint + rotation times
 * (the read-only companion to the destructive `backup rotate-key`). In-binary: a
 * plain kubectl read of the platform/backup-target-key Secret (same fields the
 * `make backup-target-key-status` target prints).
 */
export async function backupKeyStatus(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const kc = deps.env.KUBECONFIG ? [] : ['--kubeconfig', '/etc/rancher/k3s/k3s.yaml'];
  const getField = async (field: string): Promise<string | null> => {
    const r = await deps.exec(
      'kubectl',
      [...kc, '-n', 'platform', 'get', 'secret', 'backup-target-key', '-o', `jsonpath={.data.${field}}`],
      {},
    );
    if (r.code !== 0) return null; // cluster/secret unreachable
    const b64 = r.stdout.trim();
    if (!b64) return '';
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return '';
    }
  };

  const fingerprint = await getField('fingerprint');
  if (fingerprint === null) {
    deps.err('backup key-status: kubectl could not reach the cluster (KUBECONFIG unset, or cluster down?)');
    return 1;
  }
  if (fingerprint === '') {
    deps.err('backup key-status: platform/backup-target-key not found (is the cluster bootstrapped?)');
    return 1;
  }
  const generatedAt = (await getField('generated_at')) || '';
  const rotatedAt = (await getField('rotated_at')) || '';

  if (json) {
    deps.out(JSON.stringify({ ok: true, fingerprint, generatedAt: generatedAt || null, rotatedAt: rotatedAt || null }));
    return 0;
  }
  deps.out(`BACKUP_TARGET_KEY fingerprint: ${fingerprint}`);
  deps.out(`  generated: ${generatedAt || '(unknown)'}`);
  deps.out(`  rotated:   ${rotatedAt || '(never rotated)'}`);
  return 0;
}

export async function backupTargetCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  const json = args.includes('--json');
  const positional = rest.filter((a) => !a.startsWith('--'));
  switch (sub) {
    case 'list':
      return run(['list'], undefined, deps, json, renderList);
    case 'test': {
      const id = positional[0];
      if (!id) return usage(deps, 'test <id>');
      return run(['test', id], undefined, deps, json, renderResult);
    }
    case 'delete': {
      const id = positional[0];
      if (!id) return usage(deps, 'delete <id>');
      return run(['delete', id], undefined, deps, json, renderResult);
    }
    case 'add': {
      const stdin = await deps.readStdin();
      if (!stdin.trim()) {
        deps.err('backup target add: pipe a JSON config on stdin (createBackupConfig schema: storage_type, name, s3_endpoint, s3_bucket, s3_region, s3_access_key, s3_secret_key, …)');
        return 2;
      }
      return run(['add'], stdin, deps, json, renderResult);
    }
    case 'bind': {
      const [cls, id] = positional;
      if (!cls || !id) return usage(deps, 'bind <system|tenant|mail> <id>');
      return run(['bind', cls, id], undefined, deps, json, renderResult);
    }
    case 'unbind': {
      const cls = positional[0];
      if (!cls) return usage(deps, 'unbind <system|tenant|mail>');
      return run(['unbind', cls], undefined, deps, json, renderResult);
    }
    default:
      deps.err(`backup target: expected list|add|test|delete|bind|unbind, got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}
