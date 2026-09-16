/**
 * The links a notification carries.
 *
 * Operator requirement 2026-09-16: a notification may have MORE THAN ONE link,
 * some inline inside the sentence (a tenant name that opens that tenant) and
 * some as action buttons ("Review mail operations"). One "open the subsystem
 * page" link per notification was the reason an alert about a specific tenant
 * landed the operator on a list of all of them.
 *
 * Relationship to `action-path.ts`: that module owns the PRIMARY destination —
 * the one the in-app bell navigates to and the one ntfy click-through uses —
 * and it stays the single source of truth for it. This module adds the extra
 * links and turns all of them into absolute URLs. Splitting primary from
 * extras keeps one fact in one place rather than two registries that can
 * disagree about where a category points.
 *
 * Why the rendered forms are built HERE and not in the templates: the email
 * renderer escapes variables for injection safety (correctly), so an anchor
 * passed as a variable would be shown as literal markup. The dispatcher builds
 * the markup, escaping every label itself, and the template opts in with a
 * triple-stash. A Handlebars `{{#each}}` was the obvious alternative and is
 * worse: the strict renderer would report the loop-scoped `{{url}}`/`{{text}}`
 * as variables no emitter supplies, i.e. a false degradation on every single
 * notification.
 */
import { notificationActionPath } from './action-path.js';

export type LinkStyle = 'primary' | 'secondary';

interface LinkSpec {
  readonly text: string;
  /** Panel-relative path. `:tenantId` is substituted from the event. */
  readonly path: string;
  readonly style: LinkStyle;
}

export interface ResolvedLink {
  readonly text: string;
  readonly url: string;
  readonly style: LinkStyle;
}

/**
 * Extra links per category, beyond the primary destination.
 *
 * Deliberately short. A notification with five buttons has no primary action,
 * which is the same problem as having none — so an entry here has to earn its
 * place by being a DIFFERENT thing the reader plausibly wants to do.
 */
const EXTRA_LINKS: Readonly<Record<string, readonly LinkSpec[]>> = {
  // A saturated sender is either a compromise or a capacity problem. The
  // tenant's own page answers "who is this", mail operations answers "what is
  // the platform doing about it".
  'admin.email_quota_exceeded': [
    { text: 'Open mail operations', path: '/email/operations', style: 'secondary' },
  ],
  // The limit lives on the tenant record; the usage lives on the mail page.
  'admin.mailbox_quota_fleet': [
    { text: 'Open mail operations', path: '/email/operations', style: 'secondary' },
  ],
  // An OOM needs the workload AND the node it happened on.
  'admin.tenant_pod_oom': [
    { text: 'Open node health', path: '/cluster/nodes', style: 'secondary' },
  ],
  'admin.node_memory_event_critical': [
    { text: 'Open monitoring', path: '/monitoring', style: 'secondary' },
  ],
  'admin.node_memory_event_warning': [
    { text: 'Open monitoring', path: '/monitoring', style: 'secondary' },
  ],
  // A failing backup is answered either by the schedule or by the target.
  'admin.backup_failed': [
    { text: 'Check backup targets', path: '/backups/targets', style: 'secondary' },
  ],
  'admin.backup_stale': [
    { text: 'Check backup targets', path: '/backups/targets', style: 'secondary' },
  ],
  'admin.wal_archive_failing': [
    { text: 'Check backup targets', path: '/backups/targets', style: 'secondary' },
  ],
  // Certificates fail for DNS reasons far more often than for cert reasons.
  'admin.cert_issuance_failed': [
    { text: 'Check DNS records', path: '/dns', style: 'secondary' },
  ],
  'tls.certificate_failed': [
    { text: 'Check your DNS records', path: '/domains', style: 'secondary' },
  ],
  // The tenant needs to see their own usage next to the limit that stopped them.
  'tenant.email_quota_exceeded': [
    { text: 'View resource usage', path: '/resource-usage', style: 'secondary' },
  ],
  'tenant.email_quota_warning': [
    { text: 'View resource usage', path: '/resource-usage', style: 'secondary' },
  ],
  'mailbox.quota_exceeded': [
    { text: 'Open webmail', path: '/email', style: 'secondary' },
  ],
};

/** Admin categories land in the admin panel; everything else in the tenant panel. */
export function isAdminCategory(categoryId: string): boolean {
  return categoryId.startsWith('admin.');
}

function absolute(base: string | null, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}${path}`;
}

export interface LinkPath {
  readonly text: string;
  readonly path: string;
  readonly style: LinkStyle;
}

/**
 * The links as PANEL-RELATIVE paths.
 *
 * The in-app feed is already inside the panel, so it wants paths, not absolute
 * URLs — and computing them at read time (like `actionPath` has always been)
 * means historical rows get the links too, with no column to backfill. Email
 * builds absolute URLs from the same list below, so there is one registry and
 * two renderings rather than two registries that drift.
 */
export function linkPathsFor(input: {
  readonly categoryId: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly tenantId: string | null;
}): readonly LinkPath[] {
  const out: LinkPath[] = [];
  const primaryPath = notificationActionPath({
    categoryId: input.categoryId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
  });
  if (primaryPath) out.push({ text: 'Open in the panel', path: primaryPath, style: 'primary' });

  for (const spec of EXTRA_LINKS[input.categoryId] ?? []) {
    const path = spec.path.replace(':tenantId', input.tenantId ?? '');
    if (path.includes(':') || path.endsWith('/')) continue;
    out.push({ text: spec.text, path, style: spec.style });
  }
  return out;
}

export interface ResolveLinksInput {
  readonly categoryId: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly tenantId: string | null;
  readonly adminBaseUrl: string | null;
  readonly tenantBaseUrl: string | null;
}

/**
 * Every link for this event, primary first, as absolute URLs.
 *
 * Returns an empty list when the relevant panel URL is not configured — a
 * relative path in an email is a dead link, and a dead link is worse than no
 * button because the reader spends a click finding that out.
 */
export function resolveNotificationLinks(input: ResolveLinksInput): readonly ResolvedLink[] {
  const base = isAdminCategory(input.categoryId) ? input.adminBaseUrl : input.tenantBaseUrl;
  if (!base) return [];

  const links: ResolvedLink[] = [];
  for (const l of linkPathsFor(input)) {
    const url = absolute(base, l.path);
    if (url) links.push({ text: l.text, url, style: l.style });
  }
  return links;
}

/** Minimal HTML escaping for a label the platform puts inside an anchor. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An inline anchor for use with a triple-stash.
 *
 * The LABEL is escaped here because it is real data — a tenant name, a mailbox
 * address — and the template cannot escape it once it has opted out of
 * escaping for the anchor.
 */
export function inlineLink(label: string | null | undefined, url: string | null): string | null {
  const text = label?.trim();
  if (!text || !url) return null;
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

/** The action buttons, pre-rendered as MJML for the shared email wrapper. */
export function renderActionButtons(links: readonly ResolvedLink[]): string {
  if (links.length === 0) return '';
  return links
    .map((l) => `<mj-button href="${escapeHtml(l.url)}">${escapeHtml(l.text)}</mj-button>`)
    .join('\n');
}
