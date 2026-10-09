/**
 * `platform-ops self-upgrade` orchestrator (ADR-045 W11.5).
 *
 * Keeps the operator CLI binary current: resolve a target version (explicit
 * --version, else the cluster's platform-version ConfigMap — never GitHub's
 * latest: a node must not run ahead of its cluster), and if it's newer (or --force), download the signed binary,
 * cosign-VERIFY it (the single trust gate — reused from the W11 poller, pure
 * Node crypto, no cosign binary), and atomically replace the running binary.
 *
 * Fail-closed: an unverifiable binary is NEVER installed. A downgrade can only
 * happen via an explicit `--version` + `--force` (a MITM'd "latest" pointing at
 * an older release is naturally refused by the not-newer gate). Pure over
 * `SelfUpgradeDeps` so the whole flow is unit-testable.
 */

import { isValidVersion, isNewerVersion } from '../../../modules/platform-updates/poller/semver.js';
import type {
  SelfUpgradeDeps,
  SelfUpgradeOptions,
  SelfUpgradeResult,
  TargetSource,
} from './types.js';

export async function runSelfUpgrade(
  opts: SelfUpgradeOptions,
  deps: SelfUpgradeDeps,
): Promise<SelfUpgradeResult> {
  const current = deps.currentVersion();
  const arch = deps.arch();
  const base = { current, arch } as const;

  // 1) Resolve the target version.
  let target: string | null = null;
  let source: TargetSource | null = null;
  if (opts.version !== undefined) {
    if (!isValidVersion(opts.version)) {
      return { ok: false, action: 'invalid-version', target: null, source: null, ...base, reason: `'${opts.version}' is not a valid version` };
    }
    target = opts.version;
    source = 'explicit';
  } else {
    // The cluster's own version, and nothing else (ADR-064). This used to fall
    // back to the newest GitHub release when the ConfigMap could not be read — a
    // node that lost API access then installed a release NEWER than its cluster,
    // which a self-upgrade can never undo (no downgrade without --force).
    const running = await deps.readRunningVersion();
    if (running && isValidVersion(running)) {
      target = running;
      source = 'configmap';
    }
  }

  if (!target) {
    deps.log('warn', "[self-upgrade] could not read the cluster's version (platform-version ConfigMap) — not guessing; will retry on the next check");
    return { ok: true, action: 'no-target', target: null, source: null, ...base };
  }

  // 2) Version gate. A non-newer target is only applied with --force (explicit
  //    reinstall/downgrade), which also neutralises a downgrade attack via a
  //    MITM'd "latest".
  if (!opts.force && !isNewerVersion(target, current)) {
    deps.log('info', `[self-upgrade] already current (have ${current}, target ${target} via ${source})`);
    return { ok: true, action: 'already-current', target, source, ...base };
  }

  // 3) Download the arch-specific binary + its detached signature.
  const bin = await deps.downloadAsset(target, arch, 'bin');
  const sig = await deps.downloadAsset(target, arch, 'sig');
  if (!bin || !sig) {
    deps.log('warn', `[self-upgrade] failed to download platform-ops ${target} (${arch})`);
    return { ok: false, action: 'download-failed', target, source, ...base, reason: 'asset download failed' };
  }

  // 4) cosign-verify the downloaded binary. The ONLY trust gate — fail-closed.
  const pub = deps.readPublicKey();
  if (!pub) {
    deps.log('warn', '[self-upgrade] pinned cosign public key unreadable — refusing (fail-closed)');
    return { ok: false, action: 'verify-failed', target, source, ...base, reason: 'public key unreadable' };
  }
  if (!deps.verify(bin, sig.toString('utf8'), pub)) {
    deps.log('warn', `[self-upgrade] signature verification FAILED for ${target} — refusing (fail-closed)`);
    return { ok: false, action: 'verify-failed', target, source, ...base, reason: 'cosign signature did not verify' };
  }

  // 5) Atomic replace (same-dir temp + rename; the running process keeps its
  //    old inode, so replacing a live binary is safe on Linux).
  const replaced = await deps.atomicReplace(bin);
  if (!replaced) {
    deps.log('warn', `[self-upgrade] verified ${target} but atomic replace failed`);
    return { ok: false, action: 'replace-failed', target, source, ...base, reason: 'atomic replace failed' };
  }

  deps.log('info', `[self-upgrade] upgraded ${current} → ${target} (via ${source})`);
  return { ok: true, action: 'upgraded', target, source, ...base };
}
