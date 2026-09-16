/**
 * Ranking for the static (page + tab) half of global search.
 *
 * Static entries are matched here, in the browser, against a registry
 * that ships with the bundle. That is deliberate: the nav tree is known
 * at build time, so page hits can render on the first keystroke with no
 * request in flight, and they stay usable if the record query is slow or
 * fails outright.
 */

import type { SearchResultType } from '@insula/api-contracts';

export interface RegistryEntry {
  /** Stable id — also the React key. Convention: `group.page.tab`. */
  readonly id: string;
  /** What the operator calls this thing. */
  readonly label: string;
  /** Where it lives, rendered as the second line ("Security → Web Defense"). */
  readonly group: string;
  /** In-app route, including any `?tab=`. */
  readonly to: string;
  /**
   * Words an operator might reach for that are not in the label. This is
   * what makes "modsecurity" find WAF Events and "2fa" find Identity —
   * without them the box only works for people who already know the
   * platform's vocabulary, which is exactly the people who do not need
   * search.
   */
  readonly keywords?: readonly string[];
  /**
   * Mirrors the route's `allowedRoles` in App.tsx. An entry with no
   * `roles` is visible to every authenticated user of this panel.
   * Filtered client-side so search never offers a page that renders
   * "Access Denied" the moment it is opened.
   */
  readonly roles?: readonly string[];
}

export interface StaticHit {
  readonly entry: RegistryEntry;
  readonly score: number;
}

/** Static hits are rendered as this result type in the merged dropdown. */
export const STATIC_RESULT_TYPE: SearchResultType = 'setting';

const SCORE_EXACT = 100;
const SCORE_LABEL_PREFIX = 80;
const SCORE_WORD_PREFIX = 60;
const SCORE_LABEL_SUBSTRING = 40;
const SCORE_GROUP = 20;
const SCORE_KEYWORD = 15;

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Score one entry against a query, or return 0 for no match.
 *
 * The tiers exist so that typing `mail` puts the page actually called
 * "Mail" above the six pages that merely mention mail in a keyword. A
 * flat substring filter ranks those identically and the right answer
 * ends up fourth.
 */
export function scoreEntry(entry: RegistryEntry, rawQuery: string): number {
  const q = normalise(rawQuery);
  if (q.length === 0) return 0;

  const label = normalise(entry.label);
  if (label === q) return SCORE_EXACT;
  if (label.startsWith(q)) return SCORE_LABEL_PREFIX;

  // A prefix of any word in the label: "def" finds "Web Defense".
  // Without this, only the first word is reachable by prefix and the
  // second half of every two-word page name is unsearchable.
  const labelWords = label.split(/[\s/&—–-]+/).filter(Boolean);
  if (labelWords.some((w) => w.startsWith(q))) return SCORE_WORD_PREFIX;

  if (label.includes(q)) return SCORE_LABEL_SUBSTRING;

  const group = normalise(entry.group);
  if (group.includes(q)) return SCORE_GROUP;

  if (entry.keywords?.some((k) => normalise(k).includes(q))) return SCORE_KEYWORD;

  return 0;
}

/**
 * Rank a registry against a query for one role.
 *
 * Ties break on label length, then alphabetically: with two equal-scoring
 * hits the shorter name is almost always the more general page, and a
 * stable final tiebreak stops results from reshuffling between renders
 * for no visible reason.
 */
export function searchRegistry(
  registry: readonly RegistryEntry[],
  query: string,
  role: string | undefined,
  limit: number,
): StaticHit[] {
  const q = normalise(query);
  if (q.length === 0) return [];

  const hits: StaticHit[] = [];
  for (const entry of registry) {
    // No role on the token means no page is safe to offer. This only
    // happens in the instant before /auth/me resolves; showing the full
    // admin nav to a not-yet-identified user for one frame is worse than
    // showing nothing.
    if (entry.roles && (role === undefined || !entry.roles.includes(role))) continue;
    const score = scoreEntry(entry, q);
    if (score > 0) hits.push({ entry, score });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.label.length !== b.entry.label.length) {
      return a.entry.label.length - b.entry.label.length;
    }
    return a.entry.label.localeCompare(b.entry.label);
  });

  return hits.slice(0, limit);
}
