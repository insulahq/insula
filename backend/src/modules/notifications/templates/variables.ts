/**
 * Template variable introspection — shared by the renderer, the delivery
 * path and the CI variable-contract guard.
 *
 * Why this exists
 * ---------------
 * `subscription.renewed` supplied `newExpiresAt` while all three of its
 * templates read `{{nextBillingAt}}`. Under Handlebars strict mode that
 * single mismatch failed in two different ways, and neither raised an
 * alert:
 *
 *   {{nextBillingAt}}              → THROWS  → delivery marked `skipped`,
 *                                              16/16 emails never sent
 *   {{#if nextBillingAt}}…{{/if}}  → renders '' → the in-app body silently
 *                                                 lost its date
 *
 * Both symptoms, one root cause, zero visibility. The fix is to know which
 * variables a template *references* before rendering it, so the delivery
 * path can pre-fill the absent ones with a visible marker and report them,
 * instead of letting strict mode decide between throwing and lying.
 *
 * The same extraction backs `scripts/ci-notification-variable-contract.sh`,
 * so the check that runs in CI and the behaviour that runs in production
 * cannot disagree about what a template asks for.
 */
import { LRUCache } from 'lru-cache';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

/**
 * Rendered in place of a variable the emitter never supplied. Visible on
 * purpose: a notification that silently omits its subject reads as though
 * the omission were intended, which is precisely how the renewal date
 * disappeared from sixteen messages without anyone noticing.
 */
export const MISSING_VALUE = '—';

/**
 * Re-exported from `envelope-vars.ts`, which has no imports so the CI
 * variable-contract guard can load it without a node_modules tree.
 */
export { DISPATCHER_PROVIDED, PREVIEW_ENVELOPE_SAMPLE } from './envelope-vars.js';
// Also imported for use below — a re-export alone does not bind the name in
// this module's scope.
import { DISPATCHER_PROVIDED } from './envelope-vars.js';


/**
 * Handlebars references, including block-helper subjects.
 *
 * Matches `{{x}}`, `{{{x}}}`, `{{#if x}}`, `{{#unless x}}` and dotted
 * paths (recording the root segment, which is what a caller supplies).
 * Deliberately ignores `{{/close}}`, `{{else}}` and comments.
 *
 * Block helpers matter as much as bare references: `{{#if x}}` is the form
 * that fails *silently*, so a guard that only looked for `{{x}}` would
 * report a clean contract for the template that quietly drops data.
 */
const REF_RE = /\{\{\{?\s*(?:#(?:if|unless)\s+)?([A-Za-z_][\w.]*)\s*\}?\}\}/g;

const RESERVED = new Set(['else', 'this']);

export function referencedVariables(text: string | null | undefined): readonly string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    const root = m[1].split('.')[0];
    if (RESERVED.has(root)) continue;
    out.add(root);
  }
  return [...out];
}

/**
 * Every variable a template reads across its subject AND body.
 *
 * Cached by `${id}::${version}` exactly like the compiled template, so an
 * operator PATCH that bumps the version invalidates this too. Bounded: an
 * LRU with a hard max, because the platform allows an unbounded number of
 * template versions over its lifetime and an unbounded cache keyed by
 * version is a slow memory leak.
 */
const REF_CACHE = new LRUCache<string, readonly string[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

export function templateReferencedVariables(
  template: Pick<NotificationTemplateResponse, 'id' | 'version' | 'subjectTemplate' | 'bodyTemplate'>,
): readonly string[] {
  const key = `${template.id}::${template.version}`;
  const hit = REF_CACHE.get(key);
  if (hit) return hit;
  const refs = [
    ...new Set([
      ...referencedVariables(template.subjectTemplate),
      ...referencedVariables(template.bodyTemplate),
    ]),
  ];
  REF_CACHE.set(key, refs);
  return refs;
}

export interface FilledVariables {
  /** The caller's variables plus a placeholder for every absent reference. */
  readonly variables: Record<string, unknown>;
  /**
   * References the caller never supplied, excluding the dispatcher-seeded
   * common set. Recorded on the delivery row so a thin notification is a
   * reportable defect rather than an invisible one.
   */
  readonly degradedVars: readonly string[];
}

/**
 * Pre-fill every referenced-but-absent variable with {@link MISSING_VALUE}.
 *
 * A key that is present-but-null/undefined is NOT degraded — the emitter
 * supplied it and chose an empty value, which strict mode already renders
 * as ''. Only a key the emitter never mentioned counts.
 */
export function fillMissingVariables(
  template: Pick<NotificationTemplateResponse, 'id' | 'version' | 'subjectTemplate' | 'bodyTemplate'>,
  variables: Record<string, unknown>,
): FilledVariables {
  const filled: Record<string, unknown> = { ...variables };
  const degraded: string[] = [];

  for (const ref of templateReferencedVariables(template)) {
    if (ref in filled) continue;
    filled[ref] = MISSING_VALUE;
    if (!DISPATCHER_PROVIDED.has(ref)) degraded.push(ref);
  }

  return { variables: filled, degradedVars: degraded };
}

/** Test-only seam. */
export function _resetVariableCacheForTests(): void {
  REF_CACHE.clear();
}
