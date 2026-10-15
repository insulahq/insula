/**
 * How long each bundle capture Job may run, in one place so the stuck-bundle
 * sweeper (`retention.ts`) can never be shorter than a capture it would cut off.
 *
 * Sized for a FULL read. The files capture compares against the tenant's
 * previous snapshot and normally reads little, but the first capture after a
 * volume is rewritten (first bundle, restore, shrink) reads everything: ~10 min
 * for 30 GB on a healthy node, and more than 29 min on a node whose disk had
 * slowed. The largest mailbox capture has taken ~18 min. The wave bundles one
 * tenant at a time, so this is also the longest one stuck capture can hold up
 * the tenants after it.
 */
export const FILES_CAPTURE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAILBOXES_CAPTURE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Margin on top of the slowest capture before a `running` bundle counts as
 * orphaned: the database pre-dumps run before the files capture (up to 5 min
 * per deployment, one after another), the capture may first wait for a
 * cluster concurrency slot, and finalisation runs after it.
 */
const BUNDLE_OVERHEAD_MS = 60 * 60 * 1000;

/** The longest a healthy bundle can stay `running`. */
export const BUNDLE_MAX_RUNNING_MS =
  Math.max(FILES_CAPTURE_TIMEOUT_MS, MAILBOXES_CAPTURE_TIMEOUT_MS) + BUNDLE_OVERHEAD_MS;
