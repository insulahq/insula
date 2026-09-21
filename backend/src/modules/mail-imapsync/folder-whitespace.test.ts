/**
 * Folder names that differ from the destination's only by whitespace.
 *
 * A production migration could never finish. Seven source folders were named
 * with a trailing space, and each produced the same deadlock:
 *
 *     CREATE "Acme "  -> NO [ALREADYEXISTS] Mailbox 'Acme' already exists
 *     SELECT "Acme "  -> NO [NONEXISTENT]   Mailbox does not exist
 *
 * Stalwart normalises the name on CREATE — so it reports the TRIMMED name as
 * already existing — and does not normalise on SELECT, so the padded name
 * resolves to nothing. Two errors per folder, 14 in total, exit 116
 * (EXIT_ERR_CREATE), and a job that reported "the sync looks good" in the same
 * breath because the folders it could not open were never counted.
 *
 * WHAT WAS VERIFIED WHERE, so the next person knows what this file does and
 * does not prove:
 *
 *   - Stalwart's normalisation was MEASURED against a live server: it trims
 *     leading and trailing whitespace, per hierarchy COMPONENT, tabs included.
 *     `"x /child"` is stored as `"x/child"`.
 *   - The emitted expressions were run through REAL PERL against the seven
 *     folder names from the failing job, and produce exactly those stored
 *     names.
 *   - This file locks the wiring, and re-states the mapping as a JS port so a
 *     change to the expressions has to restate its intent. It does NOT execute
 *     Perl; vitest cannot.
 */
import { describe, it, expect } from 'vitest';
import { FOLDER_WHITESPACE_EXPRESSIONS } from './service.js';

/** The same two substitutions, ported to JS. Perl and JS agree on all of \s, ^, $ and /g here. */
function normalise(name: string): string {
  return name.replace(/\s*\/\s*/g, '/').replace(/^\s+|\s+$/g, '');
}

describe('folder-name whitespace normalisation', () => {
  it('maps each shape from the failing job to the name Stalwart stores', () => {
    // The SHAPES that broke a real migration, with the customer's own folder
    // names replaced — this repository is public. Seven folders failed; every
    // one matched one of these forms.
    //
    // Left: as the source server named it. Right: as Stalwart stores it, read
    // back over IMAP from the affected mailbox.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Acme ', 'Acme'],                                   // one trailing space
      ['Example Partners  ', 'Example Partners'],          // two
      ['INVOICES ', 'INVOICES'],                           // upper-case
      ['Jane Doe ', 'Jane Doe'],                           // a space already inside
      ['QUOTES/&ARI-xample Energy ', 'QUOTES/&ARI-xample Energy'], // UTF-7, nested
      ['Offshore Survey ', 'Offshore Survey'],
      ['Widget Mining ', 'Widget Mining'],
    ];
    for (const [source, stored] of cases) {
      expect(normalise(source), source).toBe(stored);
    }
  });

  it('handles the whitespace that is NOT at the end of the name', () => {
    // The obvious fix — trim the end — would have left these broken in
    // exactly the same way, because Stalwart trims per component.
    expect(normalise('Parent /Child')).toBe('Parent/Child');
    expect(normalise('A / B / C ')).toBe('A/B/C');
    expect(normalise(' Leading')).toBe('Leading');
    expect(normalise('Tab\t')).toBe('Tab');
  });

  it('leaves ordinary names, and spaces INSIDE a name, alone', () => {
    for (const n of ['Normal/Folder', 'Spaces inside kept', 'Junk Mail', 'INBOX']) {
      expect(normalise(n)).toBe(n);
    }
  });

  it('emits a separator rule as well as an ends rule', () => {
    // Two distinct substitutions; one alone cannot cover both cases.
    expect(FOLDER_WHITESPACE_EXPRESSIONS).toHaveLength(2);
    expect(FOLDER_WHITESPACE_EXPRESSIONS[0]).toContain('/');
    expect(FOLDER_WHITESPACE_EXPRESSIONS[1]).toContain('^');
    for (const e of FOLDER_WHITESPACE_EXPRESSIONS) {
      expect(e.endsWith('g'), `${e} must be global`).toBe(true);
    }
  });
});
