/**
 * Wildcard routing: Traefik rule generation, priority banding and slugs.
 *
 * The priority tests are the security-relevant ones — see the comment
 * block above `routePriority` in traefik-types.ts. A wildcard that
 * outranks an exact rule silently steals the platform's own webmail /
 * autodiscover hostnames, which live on tenant domains.
 */

import { describe, it, expect } from 'vitest';
import {
  hostMatch,
  hostAndPathMatch,
  routeMatch,
  routePriority,
  routePriorityFields,
  escapeRegexpLiteral,
  WILDCARD_PRIORITY_CEILING,
} from './traefik-types.js';
import { hostnameToSlug, isApexHostname } from './service.js';

describe('hostMatch', () => {
  it('emits an exact Host() rule for a concrete hostname', () => {
    expect(hostMatch('app.example.test')).toBe('Host(`app.example.test`)');
  });

  it('emits a single-label HostRegexp for a wildcard', () => {
    // Host() has no wildcard form in Traefik v3 — a literal
    // Host(`*.example.test`) compiles and then matches nothing.
    expect(hostMatch('*.example.test')).toBe(
      'HostRegexp(`(?i)^[^.]+\\.example\\.test$`)',
    );
  });

  it('supports wildcards at deeper levels', () => {
    expect(hostMatch('*.a.example.test')).toBe(
      'HostRegexp(`(?i)^[^.]+\\.a\\.example\\.test$`)',
    );
  });

  it('escapes regexp metacharacters in the base name', () => {
    // Dots must be escaped or `*.example.test` would also match
    // `wwwXexampleYtest`.
    expect(escapeRegexpLiteral('a.example.test')).toBe('a\\.example\\.test');
  });

  it('normalises case and trailing dots', () => {
    expect(hostMatch('APP.Example.Test.')).toBe('Host(`app.example.test`)');
  });

  it('still refuses backticks', () => {
    expect(() => hostMatch('evil`).PathPrefix(`/')).toThrow();
    expect(() => hostAndPathMatch('app.example.test', '/x`')).toThrow();
  });
});

describe('routeMatch', () => {
  it('adds a PathPrefix only for non-root paths', () => {
    expect(routeMatch('app.example.test', '/')).toBe('Host(`app.example.test`)');
    expect(routeMatch('app.example.test', null)).toBe('Host(`app.example.test`)');
    expect(routeMatch('app.example.test', '/api/')).toBe(
      'Host(`app.example.test`) && PathPrefix(`/api/`)',
    );
  });

  it('composes wildcards with paths', () => {
    expect(routeMatch('*.example.test', '/api/')).toBe(
      'HostRegexp(`(?i)^[^.]+\\.example\\.test$`) && PathPrefix(`/api/`)',
    );
  });
});

describe('routePriority', () => {
  it('leaves exact hostnames on Traefik\'s default', () => {
    expect(routePriority('app.example.test', '/')).toBeUndefined();
    expect(routePriorityFields('app.example.test', '/')).toEqual({});
  });

  it('keeps every wildcard below the shortest possible exact rule', () => {
    // Traefik's default priority is the rule LENGTH. The shortest exact
    // rule we could ever emit is a two-label domain.
    const shortestExactRule = 'Host(`a.io`)'.length;
    expect(WILDCARD_PRIORITY_CEILING).toBeLessThan(shortestExactRule);

    for (const host of ['*.example.test', '*.a.b.c.d.e.f.g.example.test']) {
      for (const path of ['/', '/deeply/nested/path/']) {
        for (const child of [false, true]) {
          const p = routePriority(host, path, { child }) as number;
          expect(p).toBeLessThanOrEqual(WILDCARD_PRIORITY_CEILING);
          expect(p).toBeLessThan(shortestExactRule);
        }
      }
    }
  });

  it('ranks a deeper wildcard above a shallower one', () => {
    const shallow = routePriority('*.example.test', '/') as number;
    const deep = routePriority('*.a.example.test', '/') as number;
    expect(deep).toBeGreaterThan(shallow);
  });

  it('ranks a path-narrowed wildcard above the bare host', () => {
    expect(routePriority('*.example.test', '/api/') as number).toBeGreaterThan(
      routePriority('*.example.test', '/') as number,
    );
  });

  it('ranks a child route above its own parent', () => {
    expect(
      routePriority('*.example.test', '/admin/', { child: true }) as number,
    ).toBeGreaterThan(routePriority('*.example.test', '/admin/') as number);
  });

  it('emits a spreadable field object for wildcards', () => {
    expect(routePriorityFields('*.example.test', '/')).toEqual({
      priority: routePriority('*.example.test', '/'),
    });
  });
});

describe('hostnameToSlug', () => {
  it('slugifies a concrete hostname', () => {
    expect(hostnameToSlug('blog.example.test')).toBe('blog-example-test');
  });

  it('does not collide a wildcard with the name it sits under', () => {
    // Without the explicit prefix both collapse to 'example-test' and
    // two routes end up sharing one CNAME target.
    expect(hostnameToSlug('*.example.test')).toBe('wildcard-example-test');
    expect(hostnameToSlug('example.test')).toBe('example-test');
    expect(hostnameToSlug('*.a.example.test')).toBe('wildcard-a-example-test');
  });

  it('stays within a DNS label', () => {
    const slug = hostnameToSlug(`*.${'a'.repeat(70)}.example.test`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('isApexHostname', () => {
  it('does not treat a wildcard as the apex', () => {
    expect(isApexHostname('*.example.test', 'example.test')).toBe(false);
    expect(isApexHostname('example.test', 'example.test')).toBe(true);
  });
});
