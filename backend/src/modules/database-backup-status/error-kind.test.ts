import { describe, expect, it } from 'vitest';
import { DUMP_ERROR_LABELS, dumpErrorKind } from './error-kind.js';
import { DUMPS_DID_NOT_RUN_PREFIX, SNAPSHOT_NOT_KEPT_ERROR } from './recorder.js';

describe('dumpErrorKind — what a tenant is told about a failed dump', () => {
  it.each([
    ['mongodump is not available in this MongoDB container image, so this database has no logical backup.', 'tool_missing'],
    ['sh: mariadb-dump: command not found', 'tool_missing'],
    ['PVC 93% full — logical dump skipped to avoid filling the volume', 'volume_full'],
    ['mysqldump: Got error: 28: No space left on device', 'volume_full'],
    ["ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)", 'access_denied'],
    ['pg_dump: error: connection to server failed: FATAL: password authentication failed', 'access_denied'],
    ['the dump timed out after 300 s', 'timed_out'],
    ['No running pod found for this deployment', 'not_running'],
    ["ERROR 2002 (HY000): Can't connect to local server through socket '/run/mysqld/mysqld.sock'", 'not_running'],
    ['dump interrupted - the file manager stopped before it finished (exit 137)', 'interrupted'],
    [SNAPSHOT_NOT_KEPT_ERROR, 'not_kept'],
    [`${DUMPS_DID_NOT_RUN_PREFIX}: the pre-dump step failed: connect ETIMEDOUT 10.42.0.7:6443`, 'did_not_run'],
    ["mariadb-dump: Couldn't execute 'SHOW FUNCTION STATUS WHERE Db = 'crm'': Column count of mysql.proc is wrong", 'other'],
  ])('%s → %s', (error, kind) => {
    expect(dumpErrorKind(error)).toBe(kind);
  });

  it('no error, no kind', () => {
    expect(dumpErrorKind(null)).toBeNull();
    expect(dumpErrorKind('')).toBeNull();
  });

  it('every label is a fixed sentence that carries nothing from the error', () => {
    for (const label of Object.values(DUMP_ERROR_LABELS)) {
      expect(label).toMatch(/^[A-Z][^\n]*\.$/);
      expect(label).not.toMatch(/\d+\.\d+\.\d+\.\d+|\/|serviceaccount/i);
    }
  });
});
