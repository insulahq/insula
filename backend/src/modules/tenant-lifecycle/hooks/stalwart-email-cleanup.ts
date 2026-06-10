import { eq } from 'drizzle-orm';
import { emailDomains } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { destroyStalwartArtifactsForEmailDomain } from '../../email-domains/service.js';

/**
 * stalwart-email-cleanup hook ('deleted' transition only).
 *
 * Tenant deletion removes email_domains / mailboxes rows via the SQL
 * FK cascade in cascades.applyDeleted — which never talks to Stalwart.
 * Without this hook every deleted tenant strands its Stalwart Domain
 * principal, the linked DkimSignature rows, and every mailbox
 * principal forever (caught live on testing 2026-06-10: a day of
 * integration runs left 11 orphaned `mail-e2e-*` Domains + 17 DKIM
 * signatures, only removable by hand because Stalwart refuses linked
 * destroys with `objectIsLinked`).
 *
 * MUST run while the DB rows still exist — guaranteed by the registry
 * dispatch happening in Step 1 of applyDeleted, before the tenant-row
 * delete cascades. Destruction order inside the helper:
 * mailbox principals → DkimSignatures → Domain principal.
 *
 * blocking=continue: Stalwart cleanup is best-effort by design.
 * Orphans are inert (the domain's MX is gone with the tenant) and
 * principals-sync flags them; a mail-server outage must never wedge a
 * tenant deletion.
 */
const HOOK_NAME = 'stalwart-email-cleanup';

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  const rows = await ctx.db
    .select({ id: emailDomains.id, stalwartDomainId: emailDomains.stalwartDomainId })
    .from(emailDomains)
    .where(eq(emailDomains.tenantId, ctx.tenantId));

  if (rows.length === 0) {
    return { status: 'ok', detail: 'no email domains' };
  }

  let attempted = 0;
  for (const row of rows) {
    if (!row.stalwartDomainId) continue;
    attempted += 1;
    // Failures are logged + swallowed inside the helper — a partial
    // cleanup leaves inert orphans that principals-sync surfaces.
    await destroyStalwartArtifactsForEmailDomain(ctx.db, row);
  }

  return {
    status: 'ok',
    detail: `destroyed Stalwart artifacts for ${attempted}/${rows.length} email domain(s)`,
  };
}

export const stalwartEmailCleanupHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['deleted'],
  // Order 150 — before the DB-status hooks (200+) purely for log
  // readability; all hooks run while the rows still exist (the FK
  // cascade fires after the dispatch in cascades.applyDeleted).
  order: 150,
  blocking: 'continue',
  run: runImpl,
};

let _registered = false;
export function registerStalwartEmailCleanupHook(): void {
  if (_registered) return;
  registerLifecycleHook(stalwartEmailCleanupHook);
  _registered = true;
}
