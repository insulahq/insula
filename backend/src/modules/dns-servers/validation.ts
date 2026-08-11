import { ApiError } from '../../shared/errors.js';

/**
 * Validation for DNS provider groups.
 *
 * Both rules here exist because duplicates in a group are not a cosmetic
 * problem — they break zone provisioning outright:
 *
 *   - PowerDNS rejects a POST/PATCH whose RRset contains the same record
 *     twice with HTTP 422. A group holding the same nameserver hostname
 *     twice therefore fails to set the zone's apex NS set at all, and the
 *     zone is left with whatever placeholder NS the provider invented.
 *   - Two servers sharing a display name make every operator-facing log line
 *     ("zone provisioning failed on <name>") ambiguous, which is precisely
 *     the signal you need when one member of a group is unhealthy.
 */

/** Compare nameserver hostnames case-insensitively and ignoring the root dot. */
function nsKey(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Normalise an ns_hostnames list, rejecting duplicates.
 *
 * Trims and drops empties, then throws if two entries name the same host.
 * We reject rather than silently de-duplicate so the operator finds out at
 * the point of entry instead of wondering why a nameserver they typed twice
 * only appears once.
 */
export function normalizeNsHostnames(list: readonly string[] | null | undefined): string[] {
  if (!list) return [];
  const cleaned = list.map((h) => h.trim()).filter((h) => h.length > 0);

  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const hostname of cleaned) {
    const key = nsKey(hostname);
    if (seen.has(key)) {
      duplicates.push(hostname);
      continue;
    }
    seen.set(key, hostname);
  }

  if (duplicates.length > 0) {
    const unique = Array.from(new Set(duplicates));
    throw new ApiError(
      'DUPLICATE_NS_HOSTNAME',
      `Nameserver hostname${unique.length > 1 ? 's' : ''} listed more than once: ${unique.join(', ')}`,
      400,
      {
        duplicates: unique,
        operatorError: {
          code: 'DUPLICATE_NS_HOSTNAME',
          title: 'Duplicate nameserver hostname',
          detail:
            `This DNS provider group lists ${unique.join(', ')} more than once. ` +
            `PowerDNS rejects an NS record set containing the same host twice (HTTP 422), ` +
            `so zone creation for every domain in this group would fail.`,
          remediation: [
            'Remove the duplicate entry.',
            'A group normally lists each nameserver once, e.g. ns1.example.test and ns2.example.test.',
          ],
          retryable: true,
        },
      },
    );
  }

  return Array.from(seen.values());
}

/**
 * Throw if `displayName` collides with another server already in the group.
 * Comparison is case-insensitive and whitespace-trimmed. `excludeServerId`
 * lets an update keep its own name.
 */
export function assertUniqueServerNameInGroup(
  existing: readonly { id: string; displayName: string; groupId: string | null }[],
  displayName: string,
  groupId: string | null | undefined,
  excludeServerId?: string,
): void {
  if (!groupId) return; // ungrouped servers are not constrained
  const key = displayName.trim().toLowerCase();
  const clash = existing.find(
    (s) =>
      s.groupId === groupId &&
      s.id !== excludeServerId &&
      s.displayName.trim().toLowerCase() === key,
  );
  if (!clash) return;

  throw new ApiError(
    'DUPLICATE_DNS_SERVER_NAME',
    `A DNS server named '${displayName.trim()}' already exists in this provider group.`,
    409,
    {
      displayName: displayName.trim(),
      groupId,
      operatorError: {
        code: 'DUPLICATE_DNS_SERVER_NAME',
        title: 'Duplicate DNS server name in group',
        detail:
          `This provider group already contains a server called '${displayName.trim()}'. ` +
          `Names identify servers in provisioning logs and health output, so duplicates make it ` +
          `impossible to tell which member of the group failed.`,
        remediation: [
          'Give the new server a distinct display name.',
          'If you meant to edit the existing server, open it from the provider group instead.',
        ],
        retryable: true,
      },
    },
  );
}
