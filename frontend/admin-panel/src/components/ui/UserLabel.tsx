import { useAdminUsers } from '@/hooks/use-admin-users';
import { useTenantUsers } from '@/hooks/use-tenant-users';
import { MAX_PAGE_LIMIT } from '@insula/api-contracts';

/**
 * Render an actor as a person, not a UUID.
 *
 * Audit trails, WAF allowlists, rule exclusions, step-up events and the
 * secrets-coverage table all recorded WHO did something as a raw user id.
 * `0a513024-247c-45f5-b363-b131ff3350bd` answers "who added this?" with a
 * value the operator has to go and look up somewhere else, so in practice
 * nobody did.
 *
 * Resolves against BOTH admin-panel and tenant-panel users. Admin users alone
 * was not enough: a WAF rule exclusion or allowlist entry created by a TENANT
 * shows an id that is not in `/admin/users`, so those rows fell through to the
 * truncated-uuid branch and the "By / When" column read as a raw id — the exact
 * problem this component exists to prevent, just for the other panel.
 *
 * One component, two shared queries. Both are cached by React Query under a
 * single key each, so twenty rows on a page cost two requests no matter how
 * many tables are on screen.
 *
 * Falls back to the id — never to blank. An id that resolves to nobody is
 * still the only record of who acted, and a deleted admin is exactly the case
 * where that record matters most.
 */

/** Non-user actors the platform writes into the same column. */
const SENTINELS: Record<string, string> = {
  anonymous: 'anonymous',
  system: 'system',
  '': '—',
};

export function formatUserLabel(
  id: string | null | undefined,
  users: ReadonlyArray<{ id: string; email: string; fullName: string }>,
): { text: string; title: string; known: boolean } {
  if (id == null || id in SENTINELS) {
    const text = SENTINELS[id ?? ''] ?? '—';
    return { text, title: text, known: false };
  }
  const u = users.find((x) => x.id === id);
  if (!u) {
    // Deleted or foreign actor. Show a short id so rows stay scannable, and
    // keep the full value in the tooltip — it is still the audit record.
    return { text: id.length > 12 ? `${id.slice(0, 8)}…` : id, title: id, known: false };
  }
  const name = u.fullName?.trim() || u.email;
  const text = u.fullName?.trim() && u.email ? `${name} (${u.email})` : name;
  return { text, title: `${text}\n${id}`, known: true };
}

export default function UserLabel({
  userId,
  className,
}: {
  readonly userId: string | null | undefined;
  readonly className?: string;
}) {
  const { data: admins } = useAdminUsers();
  // One page at the contract's max: this is a lookup table, not a browsable
  // list, and MAX_PAGE_LIMIT is the most the endpoint will return per request.
  // A tenant user beyond that page still falls back to the short id + full-id
  // tooltip, which is the same behaviour as a deleted actor — never blank.
  const { data: tenantUsers } = useTenantUsers({ limit: MAX_PAGE_LIMIT });
  const known_ = [...(admins?.data ?? []), ...(tenantUsers?.data ?? [])];
  const { text, title, known } = formatUserLabel(userId, known_);
  return (
    <span
      className={className ?? (known ? undefined : 'font-mono text-[11px] text-gray-500 dark:text-gray-400')}
      title={title}
    >
      {text}
    </span>
  );
}
