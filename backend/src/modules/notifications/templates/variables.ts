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
 * Variables the dispatcher pre-seeds for every render (see
 * dispatcher/dispatch.ts). They are never "missing" from an emitter's
 * point of view, so they must not be reported as degraded.
 */
export const DISPATCHER_PROVIDED: ReadonlySet<string> = new Set([
  'platformName',
  'userName',
  'tenantName',
  'contactName',
  'occurredAt',
  // Supplied per RECIPIENT, not per event: the greeting depends on who is
  // being addressed, and is deliberately null for a mailbox owner. Listing it
  // here stops the shared email wrapper's `{{#if greeting}}` from being
  // reported as an emitter that forgot a variable.
  'greeting',
  // Links (action-links.ts). Resolved per category from the primary
  // destination plus the extras registry, and pre-rendered so no template has
  // to know how to build a URL.
  'actionButtons',
  'actionUrl',
  'actionText',
  'tenantLink',
]);

/**
 * Representative values for the dispatcher-supplied variables, for surfaces
 * that render a template OUTSIDE a real dispatch — the admin preview and the
 * template editor.
 *
 * Without these, previewing any email template throws: the shared wrapper
 * references `{{greeting}}` and `{{{actionButtons}}}`, the preview renders in
 * STRICT mode, and the operator has no way to know those variables exist, let
 * alone what to type. Keyed off the same set above so the two cannot drift.
 */
export const PREVIEW_ENVELOPE_SAMPLE: Readonly<Record<string, string>> = {
  platformName: 'Insula',
  userName: 'Alex Mwangi',
  greeting: 'Hi Alex Mwangi,',
  tenantName: 'Example Ltd',
  contactName: 'Alex Mwangi',
  occurredAt: '2026-09-16 18:42 UTC',
  actionButtons: '<mj-button href="https://admin.example.test/tenants">Open in the panel</mj-button>',
  actionUrl: 'https://admin.example.test/tenants',
  actionText: 'Open in the panel',
  tenantLink: '<a href="https://admin.example.test/tenants/t1">Example Ltd</a>',
};

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
