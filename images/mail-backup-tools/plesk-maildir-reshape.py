#!/usr/bin/env python3
"""Reshape a Plesk/Dovecot Maildir++ tree into the layout imap-restore.py
expects, for the Plesk migration mail leg.

Plesk stores a mailbox at /var/qmail/mailnames/<domain>/<localpart>/Maildir:
  Maildir/{cur,new,tmp}         -> INBOX
  Maildir/.Sent/{cur,new}       -> "Sent"      (Maildir++ '.' = hierarchy sep)
  Maildir/.Sent.Archive/{...}   -> "Sent/Archive"

imap-restore.py reads cur+new per folder under <maildir-root>/<source-address>/
and CREATEs/SELECTs the folder named by the `.imap-name` sidecar (UTF-8
preserved), applying SPECIAL-USE from `.special-use` if present. We move the
message files (same emptyDir filesystem -> fast, no copy) and write the
sidecars. Nothing is transformed in the messages themselves; new/ files stay
unseen, cur/ `:2,<flags>` suffixes are read by imap-restore for system flags.
"""
import argparse
import hashlib
import os
import shutil
import sys

# IMAP name (lower-cased, first hierarchy component) -> SPECIAL-USE attribute.
SPECIAL = {
    'sent': '\\Sent', 'drafts': '\\Drafts', 'trash': '\\Trash',
    'junk': '\\Junk', 'spam': '\\Junk', 'archive': '\\Archive',
}


def move_messages(src_folder: str, dst_folder: str) -> int:
    """Move a Maildir folder's cur/ + new/ messages into dst/cur.

    imap-restore.py reads ONLY <folder>/cur, so new/ (unread) messages MUST be
    placed in cur/ or they are silently dropped — exactly the bug where a
    freshly-migrated mailbox imported 0 of its unread INBOX messages.

    A Maildir new/ filename has no `:2,<flags>` info suffix; we append an empty
    one (`:2,`) so imap-restore reads it as UNSEEN (no \\Seen flag),
    preserving the unread state. cur/ messages keep their existing
    `:2,<flags>` suffix (Seen / Answered / Flagged / …).
    """
    moved = 0
    dst_cur = os.path.join(dst_folder, 'cur')
    for sub in ('cur', 'new'):
        s = os.path.join(src_folder, sub)
        if not os.path.isdir(s):
            continue
        os.makedirs(dst_cur, exist_ok=True)
        for fn in os.listdir(s):
            sp = os.path.join(s, fn)
            if not os.path.isfile(sp):
                continue
            # new/ files (and any cur/ file lacking the info suffix) get a
            # `:2,` so they parse as a valid, unseen cur entry.
            dst_name = fn if ':2,' in fn else fn + ':2,'
            dp = os.path.join(dst_cur, dst_name)
            if os.path.exists(dp):  # guard the theoretical cur/new name clash
                dp = os.path.join(dst_cur, f'{dst_name}_{sub}')
            shutil.move(sp, dp)
            moved += 1
    return moved


def write_sidecars(dst_folder: str, imap_name: str) -> None:
    os.makedirs(dst_folder, exist_ok=True)
    with open(os.path.join(dst_folder, '.imap-name'), 'w', encoding='utf-8') as f:
        f.write(imap_name)
    first = imap_name.split('/')[0].lower()
    su = SPECIAL.get(first) or SPECIAL.get(imap_name.lower())
    if su:
        with open(os.path.join(dst_folder, '.special-use'), 'w') as f:
            f.write(su)


def safe(name: str) -> str:
    """Filesystem-safe, COLLISION-FREE dir name; the real IMAP name lives in
    .imap-name. A content hash suffix keeps distinct IMAP names (e.g.
    'Sent/Archive' vs 'Sent_Archive', which both sanitise to 'Sent_Archive')
    from merging into one directory."""
    base = ''.join(c if (c.isalnum() or c in '-_') else '_' for c in name) or 'folder'
    return f'{base}-{hashlib.sha1(name.encode()).hexdigest()[:8]}'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='Plesk Maildir dir')
    ap.add_argument('--dst', required=True, help='output <source-address> dir')
    a = ap.parse_args()

    if not os.path.isdir(a.src):
        print(f'RESHAPE fail no-maildir-at {a.src}', file=sys.stderr)
        return 2

    total = 0
    # INBOX = the Maildir root's cur/new.
    inbox = os.path.join(a.dst, 'INBOX')
    total += move_messages(a.src, inbox)
    write_sidecars(inbox, 'INBOX')

    # Dotted subfolders (Maildir++). ".Sent.Archive" -> IMAP "Sent/Archive".
    for entry in sorted(os.listdir(a.src)):
        if not entry.startswith('.') or entry in ('.', '..'):
            continue
        sp = os.path.join(a.src, entry)
        if not os.path.isdir(sp):
            continue
        parts = [p for p in entry[1:].split('.') if p]
        if not parts:
            continue
        imap_name = '/'.join(parts)
        dst_folder = os.path.join(a.dst, safe(imap_name))
        total += move_messages(sp, dst_folder)
        write_sidecars(dst_folder, imap_name)

    print(f'RESHAPE ok messages={total}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
