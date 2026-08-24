/**
 * `platform-ops operator-key …` — manage the operator AGE key: the keypair
 * whose public half (ConfigMap platform/platform-operator-recipient) encrypts
 * every secrets bundle and whose private half the operator holds offline.
 *
 * `rotate` wraps the embedded scripts/operator-key-rotate.sh (same
 * embed-and-launch pattern as `backup rotate-key`) — the recovery path when
 * the operator private key is lost. `status` is an in-binary read: cluster
 * recipient + local key-file state, so an operator can pre-check whether the
 * key on disk (or in their offline store) matches what bundles encrypt to.
 */
import type { Deps } from './deps.js';

const ROTATE_SCRIPT = 'ops/operator-key-rotate.sh' as const;
const KEY_DIR = '/var/lib/hosting-platform/operator-key';

export async function operatorKeyStatus(args: string[], deps: Deps): Promise<number> {
  const json = args.includes('--json');
  const kc = deps.env.KUBECONFIG ? [] : ['--kubeconfig', '/etc/rancher/k3s/k3s.yaml'];

  const r = await deps.exec(
    'kubectl',
    [...kc, '-n', 'platform', 'get', 'configmap', 'platform-operator-recipient', '-o', 'jsonpath={.data.recipient}'],
    {},
  );
  if (r.code !== 0) {
    deps.err('operator-key status: kubectl could not reach the cluster (KUBECONFIG unset, or cluster down?)');
    return 1;
  }
  const clusterRecipient = r.stdout.trim();

  const keyPath = `${KEY_DIR}/operator-private.key`;
  const keyFile = deps.readFile(keyPath);
  // readFile swallows EVERY error (null for absent AND unreadable). A 0600
  // root-owned key read by a non-root operator would otherwise report
  // "not present" — actively misleading for a DR-critical check.
  let keyUnreadable = false;
  if (keyFile === null) {
    const probe = await deps.exec('test', ['-e', keyPath], {});
    keyUnreadable = probe.code === 0;
  }
  const pubFile = deps.readFile(`${KEY_DIR}/operator-recipient.pub`);
  const localRecipient = pubFile?.trim().split('\n')[0]?.trim() ?? null;
  // The private-key file carries a `# public key:` comment — lets us tell
  // whether the on-disk private key matches what bundles encrypt to.
  const keyFileRecipient =
    keyFile
      ?.split('\n')
      .find((l) => l.startsWith('# public key:'))
      ?.replace('# public key:', '')
      .trim() ?? null;

  const privateKeyOnHost = keyFile !== null;
  const matches = privateKeyOnHost && !!clusterRecipient && keyFileRecipient === clusterRecipient;

  if (json) {
    deps.out(
      JSON.stringify({
        ok: true,
        clusterRecipient: clusterRecipient || null,
        privateKeyOnHost,
        privateKeyUnreadable: keyUnreadable,
        privateKeyMatchesCluster: privateKeyOnHost ? matches : null,
        recipientFile: localRecipient,
        keyDir: KEY_DIR,
      }),
    );
    return 0;
  }

  deps.out(`Cluster recipient (bundles encrypt to this):`);
  deps.out(`  ${clusterRecipient || '(missing — run bootstrap or `operator-key rotate`)'}`);
  if (keyUnreadable) {
    deps.out(`Private key on this host: ${keyPath} exists but is NOT readable`);
    deps.out('  (mode 0600, root-owned) — re-run as root for the match check.');
  } else if (privateKeyOnHost) {
    deps.out(`Private key on this host: ${KEY_DIR}/operator-private.key`);
    deps.out(
      matches
        ? '  matches the cluster recipient — copy it offline (make secrets-fetch) and shred it here.'
        : '  DOES NOT match the cluster recipient — bundles encrypt to a different key than this file!',
    );
  } else {
    deps.out('Private key on this host: not present (held offline — expected steady state).');
    deps.out('  Lost the offline key too? `insula operator-key rotate` mints a new one');
    deps.out('  (bundles exported before the rotation stay locked to the old key).');
  }
  return 0;
}

/** `operator-key` — rotate (embedded script) | status (in-binary read). */
export async function operatorKeyCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'rotate':
      return deps.runEmbeddedScript(ROTATE_SCRIPT, rest);
    case 'status':
      return operatorKeyStatus(rest, deps);
    default:
      deps.err(`operator-key: expected 'rotate' or 'status', got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}
