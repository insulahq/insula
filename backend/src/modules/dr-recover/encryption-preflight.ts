/**
 * ROADMAP R25 §4 — decide, BEFORE a fleet recover starts, whether this cluster
 * can decrypt the material the recovered tenants depend on.
 *
 * ## The failure this prevents
 *
 * `recover-all`'s documented scenario is "cluster rebuilt → restore N tenants
 * at once": the platform DB is restored from the old cluster, so every
 * envelope-encrypted column in it — backup-target credentials, registry pull
 * tokens, provider secrets — is ciphertext under the OLD cluster's
 * `PLATFORM_ENCRYPTION_KEY`. If the rebuilt cluster was bootstrapped with a
 * fresh key instead of the old one, none of it decrypts.
 *
 * Nothing about that is loud. The recover does not fail early — it runs the
 * whole per-tenant flow, which **provisions the namespace, PVC and quota first**
 * (up to a 150s poll each) and only then reaches something that needs a
 * cleartext secret. Over 50–100 tenants that is hours of work, a cluster full of
 * freshly provisioned namespaces, and a failure mode the operator meets one
 * tenant at a time. The remedy — re-bootstrap with the source cluster's
 * age-encrypted secrets bundle — is something they would rather have known
 * before the first namespace existed.
 *
 * ## What this checks, and what it cannot
 *
 * The probe is LOCAL: it decrypts ciphertext that is already in this cluster's
 * platform DB. No network, no bundle download, so it is cheap enough to run on
 * every preview.
 *
 * That covers the restored-DB case exactly, and it is the case `recover-all`
 * exists for. It does NOT prove that ciphertext *inside a bundle* decrypts —
 * on a cross-cluster migration the destination's own rows were entered by the
 * operator here and decrypt fine, while the bundle's registry tokens are still
 * the source cluster's. Only reading a bundle could settle that, and it is
 * already surfaced afterwards as a residual gap by `reconcile.ts`. So an `ok`
 * verdict here says "this cluster's stored secrets are readable", not "every
 * secret this migration touches is readable", and `summary` says so.
 *
 * `unverified` is deliberately distinct from `ok`. With nothing to probe —
 * fresh DB, no key configured — there is no evidence either way, and reporting
 * that as a pass would be the familiar bug where an empty set satisfies every
 * assertion.
 */

import { inArray } from 'drizzle-orm';
import { decrypt } from '../oidc/crypto.js';
import {
  backupJobs, backupConfigurations, deployments, customDeploymentImageCredentials,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type {
  DrEncryptionKeyPreflight,
  DrEncryptionProbe,
  DrEncryptionProbeVerdict,
} from '@insula/api-contracts';

/**
 * Cap on how many pull-credential rows are probed. Every row in the platform DB
 * is encrypted with the SAME key, so the second sample adds no information
 * about the key — the cap exists so a 100-tenant fleet does not turn a preview
 * into hundreds of AES operations. A handful still gives the operator more than
 * one `ref` to recognise in the report.
 */
export const MAX_PULL_CREDENTIAL_PROBES = 5;

/** `iv:tag:ciphertext`, or `kid:iv:tag:ciphertext` for the KID-prefixed envelope. */
const HEX = /^[0-9a-f]+$/i;

/**
 * Is this string shaped like one of the platform's AES-GCM envelopes?
 *
 * Checked BEFORE attempting a decrypt so the two failure classes stay apart: a
 * value that is not an envelope at all (legacy plaintext, an empty string, a
 * column that was never encrypted) says nothing about the key, while a
 * well-formed envelope that fails its GCM auth tag says the key is wrong.
 * Conflating them would let a single unencrypted legacy row block a migration.
 */
export function isEnvelopeShaped(value: string): boolean {
  const parts = value.split(':');
  // 3 parts = iv:tag:ct (oidc/crypto). 4 = kid:iv:tag:ct (secrets, pat-store).
  if (parts.length !== 3 && parts.length !== 4) return false;
  const hexParts = parts.length === 4 ? parts.slice(1) : parts;
  return hexParts.every((p) => p.length > 0 && p.length % 2 === 0 && HEX.test(p));
}

/**
 * Try one ciphertext against one key.
 *
 * `absent` — nothing stored (not every target has every credential column).
 * `malformed` — present but not an envelope; not a key signal, see above.
 * `wrong_key` — a real envelope that failed to authenticate. AES-GCM's tag
 *   makes this reliable: a wrong key cannot produce a passing tag.
 * `ok` — decrypted.
 */
export function probeCiphertext(
  value: string | null | undefined,
  keyHex: string,
): DrEncryptionProbeVerdict {
  if (value === null || value === undefined || value.length === 0) return 'absent';
  if (!isEnvelopeShaped(value)) return 'malformed';
  try {
    // The KID-prefixed envelope (`k1:iv:tag:ct`) carries one extra leading
    // segment; drop it so both shapes reach the same three-part decrypt. A
    // future `k2:` would need dispatching here rather than stripping.
    const parts = value.split(':');
    const threePart = parts.length === 4 ? parts.slice(1).join(':') : value;
    decrypt(threePart, keyHex);
    return 'ok';
  } catch {
    // Intentionally swallowed: node-crypto's message has been observed to echo
    // ciphertext fragments, and this verdict is rendered to an operator.
    return 'wrong_key';
  }
}

/**
 * Fold the individual probes into the verdict the route acts on.
 *
 * Pure — the DB reads happen in `runEncryptionKeyPreflight`, so the decision
 * itself is testable without a cluster.
 */
export function decideEncryptionGate(probes: readonly DrEncryptionProbe[]): DrEncryptionKeyPreflight {
  // Only `ok` and `wrong_key` are evidence about the key. `absent` and
  // `malformed` are counted nowhere — including them in `probed` would let a
  // column that was never encrypted read as a successful key check.
  const conclusive = probes.filter((p) => p.verdict === 'ok' || p.verdict === 'wrong_key');
  const ok = conclusive.filter((p) => p.verdict === 'ok').length;
  const failed = conclusive.length - ok;

  if (conclusive.length === 0) {
    return {
      verdict: 'unverified',
      probed: 0,
      ok: 0,
      failed: 0,
      probes: [...probes],
      summary:
        'The platform encryption key could not be checked: this cluster holds no '
        + 'encrypted credential to test it against. That is normal on a fresh cluster '
        + 'whose platform database was not restored — but it means a key mismatch, if '
        + 'there is one, will surface per tenant during the recover rather than here.',
      remedy: null,
    };
  }

  if (failed === 0) {
    return {
      verdict: 'ok',
      probed: conclusive.length,
      ok,
      failed: 0,
      probes: [...probes],
      summary:
        `This cluster decrypted ${ok} stored credential(s) with its platform encryption key. `
        + 'That covers the secrets held in this database. It does not cover secrets carried '
        + 'inside a bundle from another cluster — those are encrypted with the source '
        + "cluster's key and are reported after the restore if they cannot be read.",
      remedy: null,
    };
  }

  const sources = [...new Set(conclusive.filter((p) => p.verdict === 'wrong_key').map((p) => p.source))];
  return {
    verdict: 'mismatch',
    probed: conclusive.length,
    ok,
    failed,
    probes: [...probes],
    summary:
      `${failed} of ${conclusive.length} stored credential(s) could not be decrypted with this `
      + `cluster's platform encryption key (${sources.join(', ')}). The database was restored from `
      + 'a cluster whose PLATFORM_ENCRYPTION_KEY this cluster does not have, so every encrypted '
      + 'credential in it is unreadable here — including the registry tokens the recovered '
      + 'workloads need to pull their images.',
    remedy:
      'Re-bootstrap this cluster with the source cluster\'s PLATFORM_ENCRYPTION_KEY (it is in the '
      + 'age-encrypted Tier-1 secrets bundle: `make secrets-fetch HOST=<source>` then '
      + '`make secrets-restore BUNDLE=… KEY=…`), then run the recover again. To recover anyway and '
      + 're-enter every affected credential by hand afterwards, repeat the request with '
      + '`allowEncryptionKeyMismatch: true`.',
  };
}

// ── DB-touching orchestrator ─────────────────────────────────────────────────

/**
 * Probe every credential this cluster holds that the recover will depend on.
 *
 * Two independent samples, both local:
 *
 *  - **backup targets** the chosen bundles point at. Needed to read a bundle
 *    whenever the rclone shim is unavailable, and — more usefully — a row that
 *    is guaranteed to exist whenever there are bundles to recover at all.
 *  - **registry pull credentials** of the target tenants\' workloads. This is
 *    the material that throws `PAT_DECRYPT_FAILED` per workload later, so
 *    probing it tests the layer the failure actually lives in rather than a
 *    merely correlated one.
 *
 * Both are absent on a fresh cluster, which is why `unverified` exists.
 */
export async function runEncryptionKeyPreflight(
  db: Database,
  keyHex: string | undefined,
  bundleIds: readonly string[],
  tenantIds: readonly string[],
): Promise<DrEncryptionKeyPreflight> {
  // No key at all is not a mismatch — it is a cluster that cannot decrypt
  // anything, which config/index.ts already refuses to boot with in production.
  // Report it as unverified rather than inventing a verdict from nothing.
  if (!keyHex) return decideEncryptionGate([]);

  const probes: DrEncryptionProbe[] = [];

  // ── 1. Backup targets behind the chosen bundles ────────────────────────────
  if (bundleIds.length > 0) {
    const jobs = await db.select({ targetConfigId: backupJobs.targetConfigId })
      .from(backupJobs).where(inArray(backupJobs.id, [...bundleIds]));
    const configIds = [...new Set(jobs.map((j) => j.targetConfigId).filter((v): v is string => !!v))];
    if (configIds.length > 0) {
      const cfgs = await db.select().from(backupConfigurations)
        .where(inArray(backupConfigurations.id, configIds));
      for (const cfg of cfgs) {
        // A target populates exactly one credential shape. One ROW contributes
        // one probe — probing every column would let a single S3 target weigh
        // twice as much as an SSH one in the counts the operator reads.
        probes.push({
          source: 'backup_target',
          ref: cfg.id,
          label: cfg.name ?? null,
          verdict: firstConclusive([
            cfg.s3SecretKeyEncrypted, cfg.s3AccessKeyEncrypted,
            cfg.sshKeyEncrypted, cfg.sshPasswordEncrypted,
            cfg.cifsPasswordEncrypted,
          ], keyHex),
        });
      }
    }
  }

  // ── 2. Registry pull credentials of the target tenants\' workloads ──────────
  if (tenantIds.length > 0) {
    const deps = await db.select({ id: deployments.id, name: deployments.name })
      .from(deployments).where(inArray(deployments.tenantId, [...tenantIds]));
    if (deps.length > 0) {
      const nameById = new Map(deps.map((d) => [d.id, d.name]));
      const creds = await db.select({
        deploymentId: customDeploymentImageCredentials.deploymentId,
        tokenCipher: customDeploymentImageCredentials.tokenCipher,
      })
        .from(customDeploymentImageCredentials)
        .where(inArray(customDeploymentImageCredentials.deploymentId, deps.map((d) => d.id)));
      for (const cred of creds.slice(0, MAX_PULL_CREDENTIAL_PROBES)) {
        probes.push({
          source: 'image_pull_credential',
          ref: cred.deploymentId,
          label: nameById.get(cred.deploymentId) ?? null,
          verdict: probeCiphertext(cred.tokenCipher, keyHex),
        });
      }
    }
  }

  return decideEncryptionGate(probes);
}

/**
 * Verdict for a row that may store its secret in any one of several columns.
 *
 * Returns the first CONCLUSIVE verdict (`ok` / `wrong_key`), not the first
 * non-null: an `absent` or `malformed` column sitting ahead of a real envelope
 * would otherwise mask the only value that could answer the question.
 */
export function firstConclusive(
  values: readonly unknown[],
  keyHex: string,
): DrEncryptionProbeVerdict {
  let fallback: DrEncryptionProbeVerdict = 'absent';
  for (const v of values) {
    const verdict = probeCiphertext(typeof v === 'string' ? v : null, keyHex);
    if (verdict === 'ok' || verdict === 'wrong_key') return verdict;
    if (verdict === 'malformed') fallback = 'malformed';
  }
  return fallback;
}
