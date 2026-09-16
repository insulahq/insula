/**
 * Build a safe `%…%` pattern for a LIKE/ILIKE substring search.
 *
 * Two bugs this exists to stop, both of which shipped:
 *
 * 1. **Unescaped metacharacters.** `_` is LIKE's single-character
 *    wildcard and `%` its multi-character one. A user typing `_` into a
 *    search box therefore matched EVERY row, which reads as "search is
 *    broken", not as "you typed a wildcard". `domains/service.ts` had
 *    this on all three of its search paths; `tenants/service.ts`
 *    escaped correctly. Two implementations, one of them wrong, is the
 *    reason this is now a shared function.
 *
 * 2. **Backslash ordering.** Escaping `%` to `\%` before escaping
 *    backslashes would let an input of `\` become `\\` and then mangle
 *    the following escape. Backslashes go first, always.
 *
 * Callers should pair this with `ilike`, not `like` — Postgres `like` is
 * case-SENSITIVE, so `like(tenants.name, '%acme%')` never matches
 * "Acme Ltd". Every user-facing name search in this codebase wants
 * case-insensitive behaviour.
 */
export function likePattern(term: string): string {
  const escaped = term
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escaped}%`;
}
