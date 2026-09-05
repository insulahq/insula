import { useAdminUsers } from '@/hooks/use-admin-users';

/**
 * Render an actor as a person, not a UUID.
 *
 * Audit trails, WAF allowlists, rule exclusions, step-up events and the
 * secrets-coverage table all recorded WHO did something as a raw user id.
 * `0a513024-247c-45f5-b363-b131ff3350bd` answers "who added this?" with a
 * value the operator has to go and look up somewhere else, so in practice
 * nobody did.
 *
 * One component, one shared query. `useAdminUsers` is cached by React Query
 * under a single key, so twenty rows on a page cost one request no matter how
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
  const { data } = useAdminUsers();
  const { text, title, known } = formatUserLabel(userId, data?.data ?? []);
  return (
    <span
      className={className ?? (known ? undefined : 'font-mono text-[11px] text-gray-500 dark:text-gray-400')}
      title={title}
    >
      {text}
    </span>
  );
}
