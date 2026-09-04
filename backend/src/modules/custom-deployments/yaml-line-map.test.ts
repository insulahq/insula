import { describe, it, expect } from 'vitest';
import { resolveLine, parseIssuePath, withResolvedLines } from './yaml-line-map.js';

// Line numbers are shown to tenants as "go look here". A WRONG one is worse
// than none — they edit the wrong field and the error persists — so every case
// below asserts an exact line, and the unresolvable cases assert null rather
// than a best guess.
const DOC = [
  /*  1 */ '# a comment',
  /*  2 */ 'services:',
  /*  3 */ '  web:',
  /*  4 */ '    image: nginx:1.27.3',
  /*  5 */ '    ports:',
  /*  6 */ '      - "80"',
  /*  7 */ '      - "8443"',
  /*  8 */ '    deploy:',
  /*  9 */ '      resources:',
  /* 10 */ '        limits:',
  /* 11 */ '          cpus: "0.5"',
  /* 12 */ '          memory: 512M',
  /* 13 */ '',
  /* 14 */ '  cache:',
  /* 15 */ '    image: redis:7.4.1-alpine',
  /* 16 */ '    deploy:',
  /* 17 */ '      resources:',
  /* 18 */ '        limits:',
  /* 19 */ '          memory: 256M',
  /* 20 */ '',
  /* 21 */ 'volumes:',
  /* 22 */ '  cache-data: {}',
].join('\n');

describe('parseIssuePath', () => {
  it('splits keys and sequence indices', () => {
    expect(parseIssuePath('services.web.image')).toEqual([
      { kind: 'key', name: 'services' },
      { kind: 'key', name: 'web' },
      { kind: 'key', name: 'image' },
    ]);
    expect(parseIssuePath('services.web.ports[1]')).toEqual([
      { kind: 'key', name: 'services' },
      { kind: 'key', name: 'web' },
      { kind: 'key', name: 'ports' },
      { kind: 'index', at: 1 },
    ]);
  });

  it('rejects paths it should not guess at', () => {
    expect(parseIssuePath('')).toBeNull();
    expect(parseIssuePath('a..b')).toBeNull();
  });
});

describe('resolveLine', () => {
  it.each([
    ['services', 2],
    ['services.web', 3],
    ['services.web.image', 4],
    ['services.web.ports', 5],
    ['services.web.ports[0]', 6],
    ['services.web.ports[1]', 7],
    ['services.web.deploy', 8],
    ['services.web.deploy.resources.limits.cpus', 11],
    ['services.web.deploy.resources.limits.memory', 12],
    ['volumes', 21],
    ['volumes.cache-data', 22],
  ])('resolves %s to line %i', (path, line) => {
    expect(resolveLine(DOC, path)).toBe(line);
  });

  // The bug this guards: the SECOND service must not resolve to the first
  // one's lines. Both have `deploy.resources.limits.memory`, and a naive
  // first-match scan would send every cache error to line 12.
  it('resolves the second service to its own lines, not the first', () => {
    expect(resolveLine(DOC, 'services.cache')).toBe(14);
    expect(resolveLine(DOC, 'services.cache.image')).toBe(15);
    expect(resolveLine(DOC, 'services.cache.deploy.resources.limits.memory')).toBe(19);
  });

  // cache has no `cpus`. Returning line 11 (web's) would be actively harmful.
  it('returns null for a key the node does not have', () => {
    expect(resolveLine(DOC, 'services.cache.deploy.resources.limits.cpus')).toBeNull();
    expect(resolveLine(DOC, 'services.web.ports[9]')).toBeNull();
    expect(resolveLine(DOC, 'services.nonexistent.image')).toBeNull();
  });

  it('returns null for a form field that is not in the YAML at all', () => {
    expect(resolveLine(DOC, 'name')).toBeNull();
    expect(resolveLine(DOC, 'compose_yaml')).toBeNull();
  });

  it('ignores comments and blank lines when counting', () => {
    const doc = ['', '# lead', '', 'services:', '  # about web', '  web:', '    image: x:1'].join('\n');
    expect(resolveLine(doc, 'services.web.image')).toBe(7);
  });

  it('handles quoted keys and values containing colons', () => {
    const doc = ['services:', '  web:', '    image: ghcr.io/a/b:1.2', '    "odd key":  v'].join('\n');
    expect(resolveLine(doc, 'services.web.image')).toBe(3);
    expect(resolveLine(doc, 'services.web.odd key')).toBe(4);
  });

  it('handles a key sharing the dash line of its sequence item', () => {
    const doc = ['services:', '  web:', '    volumes:', '      - source: a', '        target: /b'].join('\n');
    expect(resolveLine(doc, 'services.web.volumes[0]')).toBe(4);
    expect(resolveLine(doc, 'services.web.volumes[0].source')).toBe(4);
    expect(resolveLine(doc, 'services.web.volumes[0].target')).toBe(5);
  });

  it('survives an empty or garbage document without throwing', () => {
    expect(resolveLine('', 'services.web')).toBeNull();
    expect(resolveLine('\n\n# only comments\n', 'services')).toBeNull();
    expect(resolveLine(':::::', 'services')).toBeNull();
  });
});

describe('withResolvedLines', () => {
  it('adds line only where it resolves, leaving the rest untouched', () => {
    const issues = [
      { severity: 'error', code: 'A', path: 'services.web.image', message: 'x' },
      { severity: 'error', code: 'B', path: 'name', message: 'y' },
      { severity: 'error', code: 'C', message: 'z' },
    ] as Array<{ severity: string; code: string; path?: string; message: string; line?: number }>;
    const out = withResolvedLines(DOC, issues);
    expect(out[0].line).toBe(4);
    expect(out[1].line).toBeUndefined();
    expect(out[2].line).toBeUndefined();
    // Non-mutating — the caller's array must be unchanged.
    expect(issues[0].line).toBeUndefined();
  });

  it('never overwrites a line the caller already set', () => {
    const out = withResolvedLines(DOC, [{ path: 'services.web.image', line: 99 }]);
    expect(out[0].line).toBe(99);
  });
});
