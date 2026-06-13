#!/usr/bin/env python3
"""Self-contained tests for plesk-maildir-reshape.py.

Guards the Plesk-migration mail leg's reshape, in particular the regression
where unread INBOX messages (Maildir new/) were dropped because imap-restore.py
reads ONLY cur/ — a mailbox with 10 unread messages imported 0.

Run: python3 test-plesk-maildir-reshape.py   (exit 0 = pass)
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RESHAPE = os.path.join(HERE, 'plesk-maildir-reshape.py')

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f'  FAIL: {msg}')
    else:
        print(f'  ok: {msg}')


def write(path, content=b'x'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(content)


def main() -> int:
    with tempfile.TemporaryDirectory() as t:
        src = os.path.join(t, 'src')
        dst = os.path.join(t, 'dst')
        # INBOX: 10 unread in new/ (no :2, suffix), 2 read in cur/ (:2,S)
        for i in range(10):
            write(os.path.join(src, 'new', f'162345{i}.M{i}P{i}.host'))
        write(os.path.join(src, 'cur', '100.M1P1.host:2,S'))
        write(os.path.join(src, 'cur', '101.M2P2.host:2,S'))
        # Two distinct subfolders that sanitise to the same base.
        write(os.path.join(src, '.Sent.Archive', 'new', '300.MxPx.host'))
        write(os.path.join(src, '.Sent_Archive', 'cur', '301.MyPy.host:2,S'))

        r = subprocess.run([sys.executable, RESHAPE, '--src', src, '--dst', dst],
                           capture_output=True, text=True)
        check(r.returncode == 0, f'reshape exits 0 (stderr={r.stderr.strip()})')

        inbox_cur = os.path.join(dst, 'INBOX', 'cur')
        files = os.listdir(inbox_cur) if os.path.isdir(inbox_cur) else []
        # The crux: imap-restore reads ONLY cur/, so all 12 must be here.
        check(len(files) == 12, f'INBOX/cur has all 12 messages (got {len(files)})')
        check(not os.path.isdir(os.path.join(dst, 'INBOX', 'new')),
              'INBOX/new is NOT created (everything consolidated to cur/)')
        unseen = [f for f in files if f.endswith(':2,')]
        seen = [f for f in files if ':2,S' in f]
        check(len(unseen) == 10, f'10 new/ messages marked unseen `:2,` (got {len(unseen)})')
        check(len(seen) == 2, f'2 cur/ messages keep `:2,S` (got {len(seen)})')

        # Collision-free folders: distinct IMAP names must not merge.
        subdirs = [d for d in os.listdir(dst) if d != 'INBOX']
        check(len(subdirs) == 2, f'.Sent.Archive and .Sent_Archive stay distinct (got {len(subdirs)})')
        for d in subdirs:
            cur = os.path.join(dst, d, 'cur')
            n = len(os.listdir(cur)) if os.path.isdir(cur) else 0
            check(n == 1, f'subfolder {d} has its 1 message in cur/ (got {n})')

    if failures:
        print(f'\n{len(failures)} FAILURE(S)')
        return 1
    print('\nALL PASS')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
