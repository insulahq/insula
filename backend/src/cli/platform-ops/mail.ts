/**
 * `platform-ops mail …` — mail-server operator actions that run IN the
 * platform-api pod (JMAP + in-cluster k8s). Today: rotate the webmail master
 * password — the recovery path that was previously only an admin-panel button.
 */
import type { Deps } from './deps.js';

async function rotateMaster(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const r = await deps.mailRotateMaster({ kubeconfig: deps.env.KUBECONFIG });
  if (!r.ok) {
    deps.err(`mail rotate-master-password: ${r.detail ?? 'failed'}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify(r.json));
    return 0;
  }
  const j = r.json as { rotatedAt?: string; principalDomain?: string };
  deps.out(`Rotated the webmail master password for master@${j.principalDomain ?? 'mail.<apex>'}.`);
  if (j.rotatedAt) deps.out(`  rotated at: ${j.rotatedAt}`);
  deps.out('  (Roundcube was rolled; the new password is stored in mail-secrets, not shown.)');
  return 0;
}

export async function mailCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'rotate-master-password':
      return rotateMaster(rest, deps);
    default:
      deps.err(`mail: expected 'rotate-master-password', got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}
