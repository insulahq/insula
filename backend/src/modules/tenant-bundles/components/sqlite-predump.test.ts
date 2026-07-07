/**
 * Unit tests for the SQLite pre-capture parser + script builder. The k8s
 * exec side is covered by the tenant backup/restore integration harness (E2E);
 * here we lock the line-protocol parsing + the discovery/dump script shape.
 */

import { describe, expect, it } from 'vitest';
import {
  parseSqliteDumpOutput,
  buildSqliteCaptureScript,
  SQLITE_DUMP_DIR,
} from './sqlite-predump.js';

describe('parseSqliteDumpOutput', () => {
  it('returns null when no SQLite files were found', () => {
    expect(parseSqliteDumpOutput('')).toBeNull();
    expect(parseSqliteDumpOutput('\n  \n')).toBeNull();
  });

  it('maps OK/DEGRADED/FAIL lines to dumped/degraded/failed', () => {
    const out = [
      'OK|/data/app/site.sqlite|4096',
      'DEGRADED|/data/x.db|PVC 95% full — sqlite dump skipped; raw file still captured',
      'FAIL|/data/broken.sqlite3|sqlite .dump failed (locked or corrupt)',
    ].join('\n');
    const entry = parseSqliteDumpOutput(out);
    expect(entry).not.toBeNull();
    expect(entry!.engine).toBe('sqlite');
    expect(entry!.deploymentName).toBe('(sqlite files)');
    expect(entry!.databases).toEqual([
      { name: '/data/app/site.sqlite', status: 'dumped', sizeBytes: 4096 },
      { name: '/data/x.db', status: 'degraded', sizeBytes: 0, error: expect.stringMatching(/full/) },
      { name: '/data/broken.sqlite3', status: 'failed', sizeBytes: 0, error: expect.stringMatching(/locked or corrupt/) },
    ]);
  });

  it('preserves file paths that themselves contain a pipe in the reason field only', () => {
    // The reason is taken from the LAST '|', so a normal path parses cleanly.
    const entry = parseSqliteDumpOutput('OK|/data/a b/c.sqlite|123');
    expect(entry!.databases[0]).toEqual({ name: '/data/a b/c.sqlite', status: 'dumped', sizeBytes: 123 });
  });

  it('ignores malformed lines', () => {
    expect(parseSqliteDumpOutput('garbage-no-bar\nOK|/data/x.sqlite|10')).toEqual({
      deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite',
      databases: [{ name: '/data/x.sqlite', status: 'dumped', sizeBytes: 10 }],
    });
  });
});

describe('buildSqliteCaptureScript', () => {
  it('sanitises the backupId into the dump filename + targets the dedicated dir', () => {
    const script = buildSqliteCaptureScript('bkp-abc/../evil');
    expect(script).toContain(SQLITE_DUMP_DIR);
    // path-SEPARATORS in the id are collapsed to '_' (dots are allowlisted, so
    // '..' survives — harmless mid-filename with no '/', cannot traverse).
    expect(script).toContain('predump-${rel}-bkp-abc_.._evil.sqlite.sql');
    // validates the SQLite magic header before dumping
    expect(script).toContain('SQLite format 3');
    // guards against a full PVC
    expect(script).toContain('CAP');
    // bounds the discovery
    expect(script).toContain('head -200');
  });
});
