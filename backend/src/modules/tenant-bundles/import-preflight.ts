/**
 * What an upload will import, and whether it can (ADR-063).
 *
 * Answers, before a byte is committed:
 *   - which restic UNITS the archive carries (the `files` tree, and one per
 *     mailbox — ADR-061 gives each mailbox its own snapshot)
 *   - which components are DROPPED for this caller, and why — never silently
 *   - how big the import Job's staging volume must be
 *   - whether the target tenant has the storage headroom
 *   - whether every mailbox address's domain belongs to the target tenant
 *
 * ★ `meta.json` is supplied by whoever produced the upload. Nothing here trusts
 * it: sizes are advisory (the Job's `emptyDir.sizeLimit` is the real bound and
 * an under-declared manifest evicts the Job), addresses are checked against
 * owned domains, and unit names are validated before any Job is built.
 */
import { assertSafeUnitName, type ImportUnit } from './import-job.js';
import { checkMailboxDomainOwnership, type RejectedAddress } from '../backup-restore/mailbox-domain-ownership.js';
import { resolveTenantDisplayLimits } from '../metrics/tenant-display-limits.js';
import { tenants as tenantsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';

/** Head-room multiplier on the declared total when sizing the staging volume. */
export const STAGE_SAFETY_FACTOR = 1.25;

/** Never ask for less than this — restic and tar both want elbow room. */
export const STAGE_FLOOR_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Hard ceiling, regardless of what the manifest declares.
 *
 * Without it a manifest claiming 4 TB would have the platform request a 4 TB
 * emptyDir. The Job would never schedule, but the number came from an uploaded
 * file and should never have reached the API in the first place.
 */
export const STAGE_CEILING_BYTES = 200 * 1024 * 1024 * 1024; // 200 GiB

/** Components a tenant may import for themselves (ADR-063 D4). */
export const TENANT_IMPORTABLE_COMPONENTS: ReadonlySet<string> = new Set(['files', 'mailboxes']);

export type ImportScope = 'admin' | 'tenant';

export interface DroppedComponent {
  readonly component: string;
  readonly reason: string;
}

/** A small component written straight to the object store by platform-api. */
export interface ImportObjectArtifact {
  readonly component: 'config' | 'secrets';
  readonly name: string;
  readonly sizeBytes: number;
}

export interface ImportPreflight {
  readonly sourceBundleId: string | null;
  readonly sourceTenantId: string | null;
  readonly units: ReadonlyArray<ImportUnit>;
  readonly objectArtifacts: ReadonlyArray<ImportObjectArtifact>;
  readonly dropped: ReadonlyArray<DroppedComponent>;
  readonly totalBytes: number;
  /** Kubernetes quantity for the Job's staging `emptyDir`, e.g. `"12Gi"`. */
  readonly stageSizeLimit: string;
  readonly quota: {
    readonly limitBytes: number;
    readonly incomingBytes: number;
    readonly fits: boolean;
  };
  readonly mailboxDomains: {
    readonly ok: boolean;
    readonly rejected: ReadonlyArray<RejectedAddress>;
  };
  readonly warnings: ReadonlyArray<string>;
  /**
   * The source manifest's `components` block, verbatim.
   *
   * Carried so the new bundle's meta can reuse the purely INFORMATIONAL
   * counts (`config.rowCount`, `secrets.secretCount`, `secrets.encryptionKeyId`)
   * that the import itself cannot recompute. Never used for sizing or for any
   * access decision — those read measured values only.
   */
  readonly sourceComponents: Record<string, Record<string, unknown>>;
  /** True when the import must not proceed. Distinct from a warning. */
  readonly blocked: boolean;
  readonly blockReasons: ReadonlyArray<string>;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Render bytes as a Kubernetes quantity. Always rounds UP to whole MiB. */
export function toK8sQuantity(bytes: number): string {
  const gi = 1024 ** 3;
  if (bytes >= gi) return `${Math.ceil(bytes / gi)}Gi`;
  return `${Math.max(1, Math.ceil(bytes / (1024 * 1024)))}Mi`;
}

/**
 * Clamp the declared total into a staging size the platform will actually ask for.
 *
 * ★ `quotaBytes` is the real bound, and it matters: the declared total comes
 * out of an uploaded `meta.json`, so a manifest claiming `sizeBytes: 0` would
 * otherwise get the 1 GiB floor while the archive it ships expands to
 * anything. The staging volume is node disk — letting an uploaded file decide
 * how much of it a tenant may consume is the noisy-neighbour vector this
 * platform has been bitten by before. A tenant can never stage more than
 * their own storage allowance (plus head-room); an admin import with no
 * allowance on record still stops at the platform ceiling.
 */
export function computeStageSizeLimit(totalBytes: number, quotaBytes = 0): string {
  const wanted = Math.ceil(num(totalBytes) * STAGE_SAFETY_FACTOR);
  const quotaCap = num(quotaBytes) > 0
    ? Math.ceil(num(quotaBytes) * STAGE_SAFETY_FACTOR)
    : STAGE_CEILING_BYTES;
  const ceiling = Math.min(STAGE_CEILING_BYTES, quotaCap);
  // The floor still applies: restic and tar want elbow room even for a tiny
  // bundle, and a quota below 1 GiB must not produce an unusable stage.
  return toK8sQuantity(Math.min(Math.max(STAGE_FLOOR_BYTES, wanted), Math.max(STAGE_FLOOR_BYTES, ceiling)));
}

/**
 * Derive the restic units and object artifacts a bundle's meta describes.
 *
 * Mirrors `resolveExportSources` — the export names the files unit `archive`
 * and each mailbox unit by address, so the import must look for exactly those.
 * If the two ever disagree the import silently carries nothing, which is why
 * both sides state the names rather than inferring them.
 */
export function deriveImportUnits(
  meta: Record<string, unknown>,
  scope: ImportScope,
): {
  units: ImportUnit[];
  objectArtifacts: ImportObjectArtifact[];
  dropped: DroppedComponent[];
  warnings: string[];
  /** True for the pre-ADR-061 whole-tenant blob, whose addresses are unknowable here. */
  legacyMailboxes: boolean;
} {
  const components = (meta.components ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const units: ImportUnit[] = [];
  const objectArtifacts: ImportObjectArtifact[] = [];
  const dropped: DroppedComponent[] = [];
  const warnings: string[] = [];
  let legacyMailboxes = false;

  const files = components.files;
  if (files) {
    units.push({ component: 'files', name: 'archive', sizeBytes: num(files.sizeBytes) });
  }

  const mailboxes = components.mailboxes;
  if (mailboxes) {
    const addresses = Array.isArray(mailboxes.addresses) ? mailboxes.addresses.map(String) : [];
    if (addresses.length > 0) {
      // Per-address sizes are not in meta — only the component total. Units
      // therefore carry 0 and the TOTAL drives staging. Reporting a made-up
      // per-mailbox split would be worse than admitting it is unknown.
      for (const a of addresses) units.push({ component: 'mailboxes', name: a, sizeBytes: 0 });
    } else if (mailboxes.sha256) {
      // Pre-ADR-061 capture: one whole-tenant `maildir.tar`, a FILE not a tree.
      // `restic backup <file>` handles it; restore already has a legacy branch.
      units.push({ component: 'mailboxes', name: 'maildir.tar', sizeBytes: num(mailboxes.sizeBytes) });
      legacyMailboxes = true;
      warnings.push('This bundle uses the older whole-tenant mailbox format. It will import as a single snapshot rather than one per mailbox.');
    }
  }

  for (const component of ['config', 'secrets'] as const) {
    const c = components[component];
    if (!c) continue;
    if (scope === 'tenant') {
      dropped.push({
        component,
        reason: component === 'secrets'
          ? 'Secrets hold TLS private keys and are restored by an operator only.'
          : 'Platform configuration rows are restored by an operator only.',
      });
      continue;
    }
    objectArtifacts.push({
      component,
      name: component === 'config' ? 'db-rows.json.gz' : 'tls.json.gz.enc',
      sizeBytes: num(c.sizeBytes),
    });
  }

  // Reject a hostile unit name here rather than at Job-build time, so the
  // preflight is the thing that reports it and no partial import starts.
  for (const u of units) assertSafeUnitName(u.name);

  return { units, objectArtifacts, dropped, warnings, legacyMailboxes };
}

export interface BuildImportPreflightArgs {
  readonly db: Database;
  readonly meta: Record<string, unknown>;
  readonly targetTenantId: string;
  readonly scope: ImportScope;
  /**
   * Size of the archive actually on disk, if known.
   *
   * A COMPRESSED archive of N bytes cannot expand to fewer than N bytes, so
   * this is a hard lower bound on what the import will write — and unlike the
   * manifest it is measured, not asserted. It exists so an under-declared
   * `meta.json` cannot walk past the quota check.
   */
  readonly archiveBytes?: number;
}

export async function buildImportPreflight(args: BuildImportPreflightArgs): Promise<ImportPreflight> {
  const { units, objectArtifacts, dropped, warnings, legacyMailboxes } = deriveImportUnits(args.meta, args.scope);

  const components = (args.meta.components ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const declaredBytes = ['files', 'mailboxes', 'config', 'secrets']
    .reduce((a, k) => a + num(components[k]?.sizeBytes), 0);
  // Take the larger of "what the manifest claims" and "how big the file
  // actually is". The manifest is an assertion by whoever built the archive;
  // the file size is a fact.
  const totalBytes = Math.max(declaredBytes, num(args.archiveBytes));

  const blockReasons: string[] = [];
  const allWarnings = [...warnings];

  // ── Mailbox domain ownership ────────────────────────────────────────────
  // The addresses come out of the uploaded archive. Capture bounded this by
  // accident (bundle contents were the tenant's own mailboxes); an upload does
  // not, so this is the check that has to exist before import runs.
  const addresses = units.filter((u) => u.component === 'mailboxes' && u.name.includes('@')).map((u) => u.name);
  const mailboxDomains = await checkMailboxDomainOwnership(args.db, args.targetTenantId, addresses);

  // ★ The legacy whole-tenant blob carries no address list, so there is
  // nothing here to check against owned domains — and reporting
  // `mailboxDomains.ok: true` for it would claim a verification that never
  // happened. A tenant may not import one: they cannot be asked to vouch for
  // its contents, and the only check left would be at restore time. An
  // operator may, with the gap stated.
  if (legacyMailboxes) {
    if (args.scope === 'tenant') {
      blockReasons.push(
        'This bundle uses the older whole-tenant mailbox format, whose mailbox addresses cannot be '
        + 'listed before importing. Ask an administrator to import it.',
      );
    } else {
      allWarnings.push(
        'Mailbox domain ownership cannot be verified for the older whole-tenant mailbox format — '
        + 'the archive carries no address list. Ownership is enforced when the mailboxes are restored.',
      );
    }
  }
  if (!mailboxDomains.ok) {
    const names = [...new Set(mailboxDomains.rejected.map((r) => r.domain || r.address))].slice(0, 5).join(', ');
    blockReasons.push(
      `The bundle contains mailboxes on ${mailboxDomains.rejected.length} address(es) whose mail domain this tenant does not own (${names}). `
      + 'Add and verify the domain first, or import a bundle for a tenant that owns it.',
    );
  }

  // ── Storage headroom ────────────────────────────────────────────────────
  // An admission check, NOT the staging size — see ADR-063 D2. The two answer
  // different questions and using one as the other is wrong in both directions.
  let limitBytes = 0;
  try {
    // resolveTenantDisplayLimits takes the tenant ROW (it reads planId +
    // overrides off it), not an id.
    const [tenantRow] = await args.db.select().from(tenantsTable)
      .where(eq(tenantsTable.id, args.targetTenantId)).limit(1);
    if (!tenantRow) throw new Error('tenant not found');
    const limits = await resolveTenantDisplayLimits(args.db, tenantRow);
    limitBytes = Math.max(0, Number(limits.storageLimitGi ?? 0)) * 1024 ** 3;
  } catch {
    // A limits lookup failure must not block an import; it makes the headroom
    // unknown, which is reported rather than assumed to be fine.
    allWarnings.push('Could not read this tenant’s storage limit — importing without a headroom check.');
  }
  const fits = limitBytes === 0 || totalBytes <= limitBytes;
  if (num(args.archiveBytes) > declaredBytes && declaredBytes > 0) {
    allWarnings.push(
      'The uploaded archive is larger than its manifest declares; the larger, measured size is used for the checks below.',
    );
  }
  if (!fits) {
    blockReasons.push(
      `This bundle holds ${Math.ceil(totalBytes / 1024 ** 3)} GiB but the tenant’s storage allowance is `
      + `${Math.floor(limitBytes / 1024 ** 3)} GiB. Raise the plan or free space before importing.`,
    );
  }

  if (units.length === 0) {
    blockReasons.push('This archive carries no files or mailboxes to import.');
  }
  if (dropped.length > 0) {
    allWarnings.push(
      `${dropped.length} component(s) will not be imported: ${dropped.map((d) => d.component).join(', ')}.`,
    );
  }
  if (totalBytes === 0) {
    allWarnings.push('The bundle manifest declares no sizes; staging will use the minimum allocation.');
  }

  return {
    sourceBundleId: typeof args.meta.backupId === 'string' ? args.meta.backupId : null,
    sourceTenantId: typeof args.meta.tenantId === 'string' ? args.meta.tenantId : null,
    units,
    objectArtifacts,
    dropped,
    totalBytes,
    stageSizeLimit: computeStageSizeLimit(totalBytes, limitBytes),
    quota: { limitBytes, incomingBytes: totalBytes, fits },
    mailboxDomains: { ok: mailboxDomains.ok, rejected: mailboxDomains.rejected },
    warnings: allWarnings,
    sourceComponents: components as Record<string, Record<string, unknown>>,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}
