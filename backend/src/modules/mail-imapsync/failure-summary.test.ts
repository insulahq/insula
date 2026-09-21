/**
 * A failed migration has to say what went wrong.
 *
 * It used to record `errorMessage: 'imapsync job failed — see logTail'`, which
 * is a redirection rather than a message — and the tenant notification
 * DELIBERATELY dropped it, because "The error was: imapsync job failed — see
 * logTail" reads worse than saying nothing. So an operator got a red status
 * with no reason attached, while the log underneath carried a precise account.
 *
 * The fixture below is the real shape of a production failure — imapsync's own
 * lines, with the customer's folder names replaced, because this repository is
 * public.
 */
import { describe, it, expect } from 'vitest';
import { parseImapsyncFailure } from './progress-parser.js';

/** The tail of a run that failed on folder names carrying trailing spaces. */
const FAILED_TAIL = [
  'The sync looks good, all 348 identified messages in host1 are on host2.',
  'Detected 14 errors',
  '++++ Listing 14 errors encountered during the sync ( avoid this listing with --noerrorsdump ).',
  "Err 1/14: Could not create folder [Acme ] from [INBOX.Acme ]: 584 NO [ALREADYEXISTS] Mailbox 'Acme' already exists.",
  'Err 2/14: Host2 folder Acme : Could not select: 586 NO [NONEXISTENT] Mailbox does not exist.',
  "Err 3/14: Could not create folder [Example Partners  ] from [INBOX.Example Partners  ]: 699 NO [ALREADYEXISTS] Mailbox 'Example Partners' already exists.",
  "Err 5/14: Could not create folder [INVOICES ] from [INBOX.INVOICES ]: 706 NO [ALREADYEXISTS] Mailbox 'INVOICES' already exists.",
  "Err 7/14: Could not create folder [Jane Doe ] from [INBOX.Jane Doe ]: 716 NO [ALREADYEXISTS] Mailbox 'Jane Doe' already exists.",
  "Err 9/14: Could not create folder [QUOTES/Widget Energy ] from [INBOX.QUOTES.Widget Energy ]: 959 NO [ALREADYEXISTS] Mailbox 'QUOTES/Widget Energy' already exists.",
  "Err 11/14: Could not create folder [Offshore Survey ] from [INBOX.Offshore Survey ]: 1142 NO [ALREADYEXISTS] Mailbox 'Offshore Survey' already exists.",
  "Err 13/14: Could not create folder [Widget Mining ] from [INBOX.Widget Mining ]: 1241 NO [ALREADYEXISTS] Mailbox 'Widget Mining' already exists.",
  'The most frequent error is ERR_CREATE. ',
  'Exiting with return value 116 (EXIT_ERR_CREATE) 14/50 nb_errors/max_errors PID 1',
].join('\n');

const CLEAN_TAIL = [
  'The sync is strict, all 0 identified messages in host2 are on host1.',
  'Detected 0 errors',
  'Exiting with return value 0 (EX_OK: successful termination) 0/50 nb_errors/max_errors PID 1',
].join('\n');

describe('parseImapsyncFailure', () => {
  it('reads the exit code, its label and the error count', () => {
    const f = parseImapsyncFailure(FAILED_TAIL);
    expect(f.exitCode).toBe(116);
    expect(f.exitLabel).toBe('EXIT_ERR_CREATE');
    expect(f.errorCount).toBe(14);
    expect(f.mostFrequent).toBe('ERR_CREATE');
  });

  it('names the affected folders, once each', () => {
    // Two errors are logged per folder — a failed CREATE and a failed SELECT.
    // Reporting "14 folders" would be wrong; there were seven.
    const f = parseImapsyncFailure(FAILED_TAIL);
    expect(f.folders).toContain('Acme ');
    expect(f.folders).toContain('Widget Mining ');
    expect(new Set(f.folders).size).toBe(f.folders.length);
  });

  it('KEEPS the trailing whitespace in the folder names it reports', () => {
    // The whitespace is frequently the entire cause. Trimming it for display
    // would hide the one detail that explains the failure.
    const f = parseImapsyncFailure(FAILED_TAIL);
    expect(f.folders.some((x) => x.endsWith(' '))).toBe(true);
  });

  it('builds a sentence an operator can act on', () => {
    const f = parseImapsyncFailure(FAILED_TAIL);
    expect(f.message).toContain('116');
    expect(f.message).toContain('EXIT_ERR_CREATE');
    expect(f.message).toContain('14 errors');
    expect(f.message).toContain('ERR_CREATE');
    expect(f.message).toContain('folders affected');
    // Bounded: a run can fail on hundreds of folders and this goes into a
    // database column and an email.
    expect(f.message!.length).toBeLessThan(400);
  });

  it('caps the folder list and says how many were left out', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      `Err ${i + 1}/9: Could not create folder [F${i} ] from [INBOX.F${i} ]: NO [ALREADYEXISTS] x.`).join('\n')
      + '\nExiting with return value 116 (EXIT_ERR_CREATE) 9/50 nb_errors/max_errors';
    const f = parseImapsyncFailure(many);
    expect(f.folders).toHaveLength(9);
    expect(f.message).toContain('and 4 more');
  });

  it('reports nothing for a clean run', () => {
    // "Exiting with return value 0" is also an Exiting line; a successful run
    // must not be described as a failure.
    const f = parseImapsyncFailure(CLEAN_TAIL);
    expect(f.message).toBeNull();
    expect(f.exitCode).toBe(0);
  });

  it('survives a truncated or empty tail', () => {
    // The tail is cut to a byte budget, so any line may be missing. A partial
    // explanation still beats "see logTail".
    expect(parseImapsyncFailure(null).message).toBeNull();
    expect(parseImapsyncFailure('').message).toBeNull();
    const partial = parseImapsyncFailure('Detected 3 errors\nsome truncated gib');
    expect(partial.message).toContain('3 errors');
    expect(partial.exitCode).toBeNull();
  });
});
