# Assemble the Plesk discovery inventory JSON (R1 PR 1). Runs IN the
# discovery Job (mail-backup-tools python3). Reads the tab-tagged lines
# from remote-discover.sh on stdin and prints the inventory JSON between
# sentinels for the backend (plesk-migration/discovery.ts) to parse.
import sys, json

INVENTORY_BEGIN = "===INVENTORY-JSON-BEGIN==="
INVENTORY_END = "===INVENTORY-JSON-END==="

meta = {"pleskVersion": None, "osVersion": None}
pwmodes = {}
subs = {}

def sub(name):
    return subs.setdefault(name, {
        "name": name, "sysUser": None, "domains": [], "databases": [],
        "mailboxes": [], "cronCount": 0, "mailBytes": None,
    })

def to_int(v):
    try:
        return int(v)
    except Exception:
        return None

for raw in sys.stdin:
    line = raw.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    tag = parts[0]
    try:
        if tag == "META":
            if parts[1] == "version":
                meta["pleskVersion"] = parts[2] or None
            elif parts[1] == "os":
                meta["osVersion"] = parts[2] or None
        elif tag == "PWMODE":
            if parts[1]:
                pwmodes[parts[1]] = to_int(parts[2]) or 0
        elif tag == "SUB":
            sub(parts[1])
        elif tag == "DOMAIN":
            sub(parts[1])["domains"].append({
                "name": parts[2], "docRoot": parts[3] or None, "phpVersion": parts[4] or None,
            })
        elif tag == "DB":
            sub(parts[1])["databases"].append({
                "name": parts[2], "type": parts[3] or "mysql", "sizeBytes": to_int(parts[4]),
            })
        elif tag == "MBOX":
            qbytes = to_int(parts[3])
            # mbox_quota is bytes; -1/0 = unlimited/unset -> null.
            quota_mb = (qbytes // (1024 * 1024)) if (qbytes and qbytes > 0) else None
            sub(parts[1])["mailboxes"].append({
                "address": parts[2], "quotaMb": quota_mb, "passwordType": parts[4] or None,
            })
        elif tag == "MAILSIZE":
            s = sub(parts[1])
            s["mailBytes"] = (s["mailBytes"] or 0) + (to_int(parts[2]) or 0)
        elif tag == "SUBMETA":
            s = sub(parts[1])
            if parts[2] == "sysuser":
                s["sysUser"] = parts[3] or None
            elif parts[2] == "cron":
                s["cronCount"] = to_int(parts[3]) or 0
    except IndexError:
        continue

if not pwmodes:
    pwstore = None
elif len(pwmodes) == 1:
    pwstore = next(iter(pwmodes))
else:
    pwstore = "mixed"

inv = {
    "pleskVersion": meta["pleskVersion"], "osVersion": meta["osVersion"],
    "passwordStorage": pwstore, "subscriptions": list(subs.values()),
}
print(INVENTORY_BEGIN)
print(json.dumps(inv))
print(INVENTORY_END)
