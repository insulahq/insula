/**
 * Unit tests for parseCscliJson — the cscli-stdout sanitiser.
 *
 * Regression target: cscli prepends ANSI cursor-control escapes to STDOUT
 * even with `-o json` and no TTY. The real, live-captured prefix is
 * `\x1b[?25l\x1b[?25h` (hide-cursor + show-cursor) BEFORE the opening `{`,
 * which made the previous raw `JSON.parse(stdout)` throw and produced a 500
 * on GET /api/v1/admin/security/crowdsec/allowlist. parseCscliJson must
 * strip that noise and parse cleanly.
 */

import { describe, it, expect } from 'vitest';
import { parseCscliJson } from './cscli-exec.js';

// The exact escape prefix observed in the live hexdump:
//   1b5b 3f32 356c  -> ESC [ ? 2 5 l   (hide cursor)
//   1b5b 3f32 3568  -> ESC [ ? 2 5 h   (show cursor)
const ANSI_PREFIX = '\x1b[?25l\x1b[?25h';

describe('parseCscliJson', () => {
  it('parses cscli output that begins with the real ANSI cursor-control prefix', () => {
    const raw =
      ANSI_PREFIX +
      '{\n  "name":"admin-panel","items":[{"value":"1.2.3.4","description":"x"}]}';
    const parsed = parseCscliJson<{ name: string; items: { value: string; description: string }[] }>(raw);
    expect(parsed.name).toBe('admin-panel');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].value).toBe('1.2.3.4');
    expect(parsed.items[0].description).toBe('x');
  });

  it('passes clean JSON through untouched', () => {
    const raw = '{"name":"admin-panel","items":[]}';
    const parsed = parseCscliJson<{ name: string; items: unknown[] }>(raw);
    expect(parsed.name).toBe('admin-panel');
    expect(parsed.items).toEqual([]);
  });

  it('parses a top-level array prefixed with the ANSI escape', () => {
    const raw = ANSI_PREFIX + '[\n  {"value":"10.0.0.0/8"},{"value":"::1"}\n]';
    const parsed = parseCscliJson<{ value: string }[]>(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].value).toBe('10.0.0.0/8');
    expect(parsed[1].value).toBe('::1');
  });

  it('parses cscli `null` (empty decisions list) — leading escape tolerated', () => {
    // cscli decisions list emits `null` (not []) when empty.
    expect(parseCscliJson<unknown>(ANSI_PREFIX + 'null')).toBeNull();
  });

  it('tolerates a trailing newline and trailing escape codes', () => {
    const raw = ANSI_PREFIX + '{"items":[{"value":"8.8.8.8"}]}\n\x1b[0m\n';
    const parsed = parseCscliJson<{ items: { value: string }[] }>(raw);
    expect(parsed.items[0].value).toBe('8.8.8.8');
  });

  it('strips trailing banner/warning noise on stdout after the JSON object', () => {
    const raw = ANSI_PREFIX + '{"items":[]}\nWARN something happened on stdout';
    const parsed = parseCscliJson<{ items: unknown[] }>(raw);
    expect(parsed.items).toEqual([]);
  });

  it('strips SGR colour codes embedded mid-output', () => {
    const raw = '\x1b[32m{"ok":\x1b[0mtrue}';
    const parsed = parseCscliJson<{ ok: boolean }>(raw);
    expect(parsed.ok).toBe(true);
  });

  it('throws a diagnosable error on genuinely-garbage input', () => {
    expect(() => parseCscliJson(ANSI_PREFIX + 'not json at all')).toThrowError(
      /parseCscliJson: unparseable cscli output/,
    );
  });

  it('error message includes an escaped raw preview but stays bounded', () => {
    let caught: Error | null = null;
    try {
      parseCscliJson('\x1b[?25l' + 'x'.repeat(500));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Escapes are shown via JSON.stringify so they are diagnosable in logs.
    expect(caught!.message).toContain('\\u001b[?25l');
    // Preview is bounded to ~120 chars of raw input (plus quotes/escapes),
    // so it never dumps the whole payload.
    expect(caught!.message.length).toBeLessThan(400);
  });

  it('handles empty string by throwing (not returning undefined)', () => {
    expect(() => parseCscliJson('')).toThrowError(/parseCscliJson/);
  });
});
