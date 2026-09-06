/**
 * Template seed loader — runs at boot. Inserts one active row per
 * (category, channel, locale) when none exists, and REFRESHES rows that are
 * still pristine stock templates.
 *
 * Operator edits remain sacred: a row is only ever rewritten while it is still
 * `is_seed = true` AND `edited_by_user_id IS NULL`. The moment an operator
 * saves a template it becomes theirs and this loader will not touch it again.
 *
 * WHY THE REFRESH EXISTS
 *
 * The loader used to insert-only, on the reasoning that never updating is the
 * safest way to protect operator edits. It also meant a shipped template change
 * reached FRESH INSTALLS ONLY. Caught on DEV 2026-09-06: the backend was
 * running the build that added `{{subject}}` to the SLO alert templates — so
 * every alert would finally name which certificate or host it was about — and
 * the database still held `[SLO CRITICAL] {{ruleName}}`. The code shipped, the
 * behaviour did not change, and nothing anywhere reported a problem. Production
 * would have kept the old text indefinitely.
 *
 * Insert-only protected untouched rows from a change they should have received.
 * Comparing against the stock text is what actually distinguishes "the operator
 * decided this" from "nobody has ever looked at it".
 */
import { and, eq } from 'drizzle-orm';
import { notificationTemplates } from '../../../db/schema.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import type { Database } from '../../../db/index.js';

export interface SeedTemplateResult {
  /** Rows created because no active row existed. */
  readonly inserted: number;
  /** Pristine stock rows brought up to date with the shipped seed. */
  readonly refreshed: number;
  /** Rows left alone because an operator owns them. */
  readonly operatorOwned: number;
}

type SeedVars = readonly { name: string; type: string; required?: boolean }[];

/** Order-insensitive compare — a reordered schema is not a content change. */
function sameVariables(a: SeedVars | null | undefined, b: SeedVars | null | undefined): boolean {
  const norm = (v: SeedVars | null | undefined): string => JSON.stringify(
    [...(v ?? [])]
      .map((x) => ({ name: x.name, type: x.type, required: x.required ?? false }))
      .sort((p, q) => p.name.localeCompare(q.name)),
  );
  return norm(a) === norm(b);
}

export async function seedTemplatesIfMissing(db: Database): Promise<SeedTemplateResult> {
  let inserted = 0;
  let refreshed = 0;
  let operatorOwned = 0;

  for (const tpl of ALL_SEED_TEMPLATES) {
    const [existing] = await db
      .select({
        id: notificationTemplates.id,
        subjectTemplate: notificationTemplates.subjectTemplate,
        bodyTemplate: notificationTemplates.bodyTemplate,
        bodyFormat: notificationTemplates.bodyFormat,
        variablesSchema: notificationTemplates.variablesSchema,
        isSeed: notificationTemplates.isSeed,
        editedByUserId: notificationTemplates.editedByUserId,
        version: notificationTemplates.version,
      })
      .from(notificationTemplates)
      .where(and(
        eq(notificationTemplates.categoryId, tpl.categoryId),
        eq(notificationTemplates.channel, tpl.channel),
        eq(notificationTemplates.locale, tpl.locale),
        eq(notificationTemplates.isActive, true),
      ))
      .limit(1);

    if (!existing) {
      await db.insert(notificationTemplates).values({
        categoryId: tpl.categoryId,
        channel: tpl.channel,
        locale: tpl.locale,
        subjectTemplate: tpl.subjectTemplate,
        bodyTemplate: tpl.bodyTemplate,
        bodyFormat: tpl.bodyFormat,
        variablesSchema: tpl.variablesSchema as SeedVars,
        isActive: true,
        isSeed: true,
        version: 1,
        editedByUserId: null,
      });
      inserted++;
      continue;
    }

    // Operator-owned: either they saved it (edited_by_user_id) or it was never
    // a stock row to begin with. Both are hands-off, permanently.
    if (!existing.isSeed || existing.editedByUserId !== null) {
      operatorOwned++;
      continue;
    }

    const unchanged = existing.subjectTemplate === tpl.subjectTemplate
      && existing.bodyTemplate === tpl.bodyTemplate
      && existing.bodyFormat === tpl.bodyFormat
      && sameVariables(existing.variablesSchema, tpl.variablesSchema);
    if (unchanged) continue;

    await db.update(notificationTemplates)
      .set({
        subjectTemplate: tpl.subjectTemplate,
        bodyTemplate: tpl.bodyTemplate,
        bodyFormat: tpl.bodyFormat,
        variablesSchema: tpl.variablesSchema as SeedVars,
        // Bumped so the compiled-template LRU (keyed `${id}::${version}`) cannot
        // serve the previous body from cache after this rewrite.
        version: existing.version + 1,
      })
      .where(eq(notificationTemplates.id, existing.id));
    refreshed++;
  }

  return { inserted, refreshed, operatorOwned };
}
