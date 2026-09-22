#!/usr/bin/env python3
"""Self-contained tests for INTERNALDATE capture and Maildir naming (ADR-061).

Guards two regressions that shared one cause — `deterministic_unique` defaulting
its timestamp to `time.time()`:

  1. Restore fidelity: `imap-restore.py` parses the filename's leading integer
     and replays it as the restored message's INTERNALDATE, so every restored
     message was stamped with the night the backup ran.
  2. Deduplication: a new name on every capture meant restic stored the whole
     mailbox again each night.

Run: python3 test-internaldate.py   (exit 0 = pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from imap_client import deterministic_unique, parse_internaldate  # noqa: E402

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f'  FAIL: {msg}')
    else:
        print(f'  ok: {msg}')


print('parse_internaldate')
# RFC 3501 §7.4.2 form, as Stalwart emits it inside the FETCH attribute blob.
check(
    parse_internaldate('UID 7 FLAGS (\\Seen) INTERNALDATE "01-Sep-2026 12:00:00 +0000"')
    == 1788264000,
    'UTC internaldate parses to the right epoch',
)
# A +0200 wall clock is EARLIER in UTC by two hours — the sign must not flip.
check(
    parse_internaldate('INTERNALDATE "01-Sep-2026 14:00:00 +0200"') == 1788264000,
    '+0200 offset is subtracted, not added',
)
check(
    parse_internaldate('INTERNALDATE "01-Sep-2026 10:00:00 -0200"') == 1788264000,
    '-0200 offset is added, not subtracted',
)
check(
    parse_internaldate('INTERNALDATE " 1-Sep-2026 12:00:00 +0000"') == 1788264000,
    'space-padded single-digit day parses (RFC 3501 allows it)',
)
check(parse_internaldate('UID 7 FLAGS (\\Seen)') is None,
      'absent INTERNALDATE returns None rather than a wall-clock guess')
check(parse_internaldate('INTERNALDATE "01-Xxx-2026 12:00:00 +0000"') is None,
      'unparseable month returns None')

print('deterministic_unique')
a = deterministic_unique(42, 'INBOX', 1788264000)
b = deterministic_unique(42, 'INBOX', 1788264000)
check(a == b, 'same (uid, mailbox, date) yields the same name across calls')
check(a.startswith('1788264000.'),
      'the leading integer IS the message date (imap-restore replays it)')
check(deterministic_unique(42, 'INBOX', 1788264000)
      != deterministic_unique(43, 'INBOX', 1788264000),
      'different uids do not collide')
check(deterministic_unique(42, 'Sent Items', 1788264000)
      == '1788264000.00000042_Sent_Items',
      'mailbox name is sanitised into the unique segment')

# The regression itself: the old signature accepted a `now` that defaulted to
# the wall clock. Any reintroduction of a default makes the name unstable, so
# assert the timestamp is REQUIRED.
try:
    deterministic_unique(42, 'INBOX')  # type: ignore[call-arg]
    check(False, 'timestamp is required (no wall-clock default)')
except TypeError:
    check(True, 'timestamp is required (no wall-clock default)')

print()
if failures:
    print(f'{len(failures)} FAILURE(S)')
    sys.exit(1)
print('all passed')
