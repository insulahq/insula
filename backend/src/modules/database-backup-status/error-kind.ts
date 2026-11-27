/**
 * What a tenant is told about a failed dump: a category, never the text.
 *
 * Dump and exec errors carry whatever the database client, the shell or the
 * Kubernetes API put in them — pod addresses, service-account names, paths,
 * command lines. Cutting at the operator-only markers is not enough for text
 * nobody wrote for a tenant. So tenants get one of a short, fixed list of
 * sentences, and the detail stays with the operator.
 */

import type { DatabaseBackupErrorKind } from '@insula/api-contracts';
import { SNAPSHOT_NOT_KEPT_ERROR, DUMPS_DID_NOT_RUN_PREFIX } from './recorder.js';

export type DumpErrorKind = DatabaseBackupErrorKind;

export const DUMP_ERROR_LABELS: Readonly<Record<DumpErrorKind, string>> = {
  tool_missing: 'The dump tool is not installed in this database\'s image.',
  volume_full: 'The storage volume was too full to write the dump.',
  access_denied: 'The platform could not log in to the database.',
  timed_out: 'The dump took too long and was stopped.',
  not_running: 'The database was not running.',
  interrupted: 'The dump was cut short.',
  not_kept: 'The dump was written, but the backup that keeps it failed.',
  did_not_run: 'The dump did not run.',
  other: 'The database reported an error while it was being dumped.',
};

/** Checked in order: the first match wins. */
const RULES: ReadonlyArray<readonly [DumpErrorKind, RegExp]> = [
  ['not_kept', new RegExp(`^${escape(SNAPSHOT_NOT_KEPT_ERROR)}`)],
  ['did_not_run', new RegExp(`^${escape(DUMPS_DID_NOT_RUN_PREFIX)}`)],
  ['interrupted', /\binterrupted\b|cut short/i],
  ['tool_missing', /not available in this|command not found|executable file not found|no such file or directory.*(dump|sqlite3)/i],
  ['volume_full', /\bPVC \d+% full|no space left|disk full|volume (is )?too full|past 90%/i],
  ['access_denied', /access denied|authentication failed|\b1045\b|password authentication/i],
  ['timed_out', /timed out|timeout|over \d+ s\b/i],
  ['not_running', /no running pod|not running|can't connect|connection refused|could not connect|could not be listed/i],
];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function dumpErrorKind(error: string | null | undefined): DumpErrorKind | null {
  if (!error) return null;
  for (const [kind, re] of RULES) if (re.test(error)) return kind;
  return 'other';
}
