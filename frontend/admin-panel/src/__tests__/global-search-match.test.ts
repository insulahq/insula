import { describe, it, expect } from 'vitest';
import { scoreEntry, searchRegistry, type RegistryEntry } from '@/search/match';
import { ADMIN_SEARCH_REGISTRY } from '@/search/registry';

/**
 * Ranking for the static half of global search.
 *
 * The functional bar is low — does a substring match? — but the USEFUL bar
 * is ranking: an operator typing "mail" who gets nine keyword matches above
 * the page actually called Mail will conclude the box does not work. Most of
 * these tests are about order, not membership.
 */

const entry = (over: Partial<RegistryEntry> & { id: string; label: string }): RegistryEntry => ({
  group: 'Group',
  to: '/x',
  ...over,
});

describe('scoreEntry', () => {
  const e = entry({ id: 'x', label: 'Web Defense', group: 'Security', keywords: ['modsecurity', 'crs'] });

  it('ranks an exact label match above everything else', () => {
    expect(scoreEntry(e, 'web defense')).toBeGreaterThan(scoreEntry(e, 'web'));
  });

  it('ranks a label prefix above a mid-label word prefix', () => {
    expect(scoreEntry(e, 'web')).toBeGreaterThan(scoreEntry(e, 'def'));
  });

  it('matches a prefix of any word, not just the first', () => {
    // Without this, the second half of every two-word page name is
    // unreachable — nobody types "web" when looking for the Defense page.
    expect(scoreEntry(e, 'def')).toBeGreaterThan(0);
  });

  it('ranks a group match below any label match', () => {
    expect(scoreEntry(e, 'defense')).toBeGreaterThan(scoreEntry(e, 'security'));
  });

  it('ranks a keyword match below a group match', () => {
    expect(scoreEntry(e, 'security')).toBeGreaterThan(scoreEntry(e, 'modsecurity'));
  });

  it('is case-insensitive in both directions', () => {
    expect(scoreEntry(e, 'WEB DEFENSE')).toBe(scoreEntry(e, 'web defense'));
    expect(scoreEntry(entry({ id: 'y', label: 'SLOs' }), 'slos')).toBeGreaterThan(0);
  });

  it('ignores surrounding whitespace', () => {
    expect(scoreEntry(e, '  web  ')).toBe(scoreEntry(e, 'web'));
  });

  it('returns 0 for a non-match and for an empty query', () => {
    expect(scoreEntry(e, 'zzzz')).toBe(0);
    expect(scoreEntry(e, '')).toBe(0);
    expect(scoreEntry(e, '   ')).toBe(0);
  });
});

describe('searchRegistry role filtering', () => {
  const registry: RegistryEntry[] = [
    entry({ id: 'open', label: 'Open Page' }),
    entry({ id: 'locked', label: 'Open Secret', roles: ['super_admin'] }),
  ];

  it('hides an entry whose roles exclude the caller', () => {
    const ids = searchRegistry(registry, 'open', 'support', 10).map((h) => h.entry.id);
    expect(ids).toEqual(['open']);
  });

  it('shows it to a role that is listed', () => {
    const ids = searchRegistry(registry, 'open', 'super_admin', 10).map((h) => h.entry.id);
    expect(ids).toContain('locked');
  });

  it('hides every gated entry when the role is not yet known', () => {
    // There is a frame between mount and /auth/me resolving. Showing the
    // full admin nav to an unidentified user for that frame is worse than
    // showing nothing.
    const ids = searchRegistry(registry, 'open', undefined, 10).map((h) => h.entry.id);
    expect(ids).toEqual(['open']);
  });

  it('respects the limit', () => {
    expect(searchRegistry(ADMIN_SEARCH_REGISTRY, 'a', 'super_admin', 3)).toHaveLength(3);
  });
});

describe('searchRegistry against the real admin registry', () => {
  const find = (q: string, role = 'super_admin') =>
    searchRegistry(ADMIN_SEARCH_REGISTRY, q, role, 8).map((h) => h.entry.id);

  it('has entries to search (guards against an empty-registry pass)', () => {
    // Every assertion below would pass vacuously against an empty array.
    expect(ADMIN_SEARCH_REGISTRY.length).toBeGreaterThan(50);
  });

  it('finds WAF Events by its label and by "modsecurity"', () => {
    expect(find('waf')).toContain('security.web-defense.waf');
    expect(find('modsecurity')).toContain('security.web-defense.waf');
  });

  it('finds the Pods tab, not just the Monitoring page', () => {
    expect(find('pods')[0]).toBe('monitoring.pods');
  });

  it('finds pages by a word an operator would use but the label does not contain', () => {
    expect(find('crowdsec')).toContain('security.web-defense.bans');
    expect(find('lets encrypt')).toContain('cluster.ingress-tls');
    expect(find('phpmyadmin').length + find('cpanel').length).toBeGreaterThan(0);
  });

  it('withholds super_admin-only pages from a support user', () => {
    expect(find('waf', 'support')).not.toContain('security.web-defense.waf');
    expect(find('plesk', 'support')).not.toContain('platform.plesk-migration');
  });

  it('still finds ungated pages as a support user', () => {
    expect(find('pods', 'support')).toContain('monitoring.pods');
  });

  it('gives every entry a unique id', () => {
    const ids = ADMIN_SEARCH_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('orders ties deterministically across repeated calls', () => {
    // A dropdown that reshuffles equal-scoring rows between renders makes
    // the arrow keys unusable.
    expect(find('settings')).toEqual(find('settings'));
  });
});
