/**
 * The envelope variables the DISPATCHER supplies, and sample values for
 * surfaces that render a template outside a real dispatch.
 *
 * Deliberately its own module with NO imports. It used to live in
 * `variables.ts`, which imports `lru-cache` — and
 * `scripts/ci-notification-variable-contract.sh` loads this constant through
 * node's type-stripping loader, with no node_modules available. The guard
 * therefore died with ERR_MODULE_NOT_FOUND the moment it started importing
 * the real list instead of keeping its own copy.
 *
 * The guard's whole premise is that CI and runtime share one extraction, so
 * the fix is to make the shared thing importable from both — not to give the
 * guard a second copy again, and not to install a dependency tree to read two
 * constants.
 */

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
