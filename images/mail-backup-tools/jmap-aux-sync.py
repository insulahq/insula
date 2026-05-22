#!/usr/bin/env python3
"""
jmap-aux-sync.py — capture per-account auxiliary JMAP surfaces.

Companion to imap-sync.py / jmap-sync.py: those capture mail; this
captures everything else that lives on a Stalwart account:

  - Sieve scripts        (urn:ietf:params:jmap:sieve)
  - Address books        (urn:ietf:params:jmap:contacts)  — containers
  - Contact cards        (urn:ietf:params:jmap:contacts)  — vCards
  - Calendars            (urn:ietf:params:jmap:calendars) — containers
  - Calendar events      (urn:ietf:params:jmap:calendars) — iCal events
  - Vacation response    (urn:ietf:params:jmap:vacationresponse) — singleton

Output layout — JSON sidecars under the per-account .aux/ subdir,
sitting alongside the Maildir tree produced by the mail scripts:

    <output-dir>/<account-address>/
        cur/...                 (Maildir from imap-sync.py / jmap-sync.py)
        .aux/
            manifest.json       (capture metadata + per-surface counts)
            sieve.json          (full SieveScript/get list + body bytes
                                  base64-inlined for Stalwart-fidelity restore)
            contacts.json       ({addressbooks:[...], cards:[...]})
            calendar.json       ({calendars:[...], events:[...]})
            vacation.json       (singleton VacationResponse/get list[0])

The capture format is the raw JMAP /get response shape (Stalwart-
specific @type fields preserved, no vCard/iCal conversion). Restore
re-feeds these objects into the corresponding /set methods.

Best-effort per surface: a missing capability (e.g. an account whose
Stalwart account-type doesn't expose calendars) logs a WARN line on
stderr and proceeds. A network failure on any surface is fatal — the
JSON summary on stdout still includes whatever surfaces succeeded.

Auth model: master-user proxy (`<addr>%<master_fq>`). Same secret
(`STALWART_MASTER_PASSWORD`) as the mail scripts.

Exit codes:
    0 — all surfaces captured (some may be empty)
    2 — bad CLI arguments / missing env
    3 — session bootstrap failed (auth, network)
    4 — one or more surface captures failed
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

from jmap_aux_client import (  # noqa: E402  — relative module in the image
    JMAP_URN_CORE,
    JmapAuxClient,
    JmapError,
    make_client,
    read_password_env,
)


URN_SIEVE = "urn:ietf:params:jmap:sieve"
URN_CONTACTS = "urn:ietf:params:jmap:contacts"
URN_CALENDARS = "urn:ietf:params:jmap:calendars"
URN_VACATION = "urn:ietf:params:jmap:vacationresponse"
URN_FILENODE = "urn:ietf:params:jmap:filenode"


# ── per-surface capture ────────────────────────────────────────────────────


def capture_sieve(client: JmapAuxClient, log: Any) -> dict[str, Any]:
    """SieveScript/get + Blob/get for each script body. Sieve scripts
    are stored as opaque blobs in Stalwart; we inline them base64 so the
    restore is round-trip exact.
    """
    using = [JMAP_URN_CORE, URN_SIEVE]
    try:
        acct = client.primary_account_id(URN_SIEVE)
    except JmapError as e:
        log("warn", f"sieve: no account ({e}) — skipping surface")
        return {"available": False, "scripts": []}

    # Property set per RFC 9404 §4.2 + Stalwart extensions
    res = client.call_one(using, "SieveScript/get",
                          {"accountId": acct, "ids": None,
                           "properties": ["id", "name", "isActive", "blobId"]})
    scripts_meta = res.get("list", []) or []
    out: list[dict[str, Any]] = []
    for s in scripts_meta:
        blob_id = s.get("blobId")
        if not blob_id:
            log("warn", f"sieve script {s.get('id')!r} has no blobId — skipping body")
            out.append({**s, "_body_b64": None})
            continue
        body = client.blob_download(acct, blob_id)
        import base64
        out.append({**s, "_body_b64": base64.b64encode(body).decode()})
    return {"available": True, "accountId": acct, "scripts": out}


def capture_contacts(client: JmapAuxClient, log: Any) -> dict[str, Any]:
    using = [JMAP_URN_CORE, URN_CONTACTS]
    try:
        acct = client.primary_account_id(URN_CONTACTS)
    except JmapError as e:
        log("warn", f"contacts: no account ({e}) — skipping surface")
        return {"available": False, "addressbooks": [], "cards": []}

    ab_res = client.call_one(using, "AddressBook/get", {"accountId": acct, "ids": None})
    addressbooks = ab_res.get("list", []) or []

    card_res = client.call_one(using, "ContactCard/get", {"accountId": acct, "ids": None})
    cards = card_res.get("list", []) or []

    return {
        "available": True,
        "accountId": acct,
        "addressbooks": addressbooks,
        "cards": cards,
    }


def capture_calendars(client: JmapAuxClient, log: Any) -> dict[str, Any]:
    using = [JMAP_URN_CORE, URN_CALENDARS]
    try:
        acct = client.primary_account_id(URN_CALENDARS)
    except JmapError as e:
        log("warn", f"calendars: no account ({e}) — skipping surface")
        return {"available": False, "calendars": [], "events": []}

    cal_res = client.call_one(using, "Calendar/get", {"accountId": acct, "ids": None})
    calendars = cal_res.get("list", []) or []

    evt_res = client.call_one(using, "CalendarEvent/get", {"accountId": acct, "ids": None})
    events = evt_res.get("list", []) or []

    return {
        "available": True,
        "accountId": acct,
        "calendars": calendars,
        "events": events,
    }


def capture_filenode(client: JmapAuxClient, log: Any) -> dict[str, Any]:
    """JMAP file storage — folders + files per account. Files reference
    blob bodies (uploaded via Blob/upload, fetched via Blob/get on a
    download URL). We inline file bodies base64 so the restore is
    byte-equal without needing a separate blob staging area in the
    snapshot tarball.

    For accounts that don't use Stalwart's file storage (most won't)
    this surface is empty and the capture is near-instant.
    """
    import base64
    using = [JMAP_URN_CORE, URN_FILENODE]
    try:
        acct = client.primary_account_id(URN_FILENODE)
    except JmapError as e:
        log("warn", f"filenode: no account ({e}) — skipping surface")
        return {"available": False, "nodes": []}

    res = client.call_one(using, "FileNode/get", {"accountId": acct, "ids": None})
    nodes = res.get("list", []) or []
    out: list[dict[str, Any]] = []
    for n in nodes:
        blob_id = n.get("blobId")
        node = dict(n)
        if blob_id:
            # File node — fetch the body.
            try:
                body = client.blob_download(acct, blob_id)
                node["_body_b64"] = base64.b64encode(body).decode()
            except JmapError as e:
                log("warn", f"filenode {n.get('id')!r} blob download failed: {e} "
                            f"— recording metadata only")
                node["_body_b64"] = None
                node["_body_error"] = str(e)
        else:
            # Folder — no body.
            node["_body_b64"] = None
        out.append(node)
    return {"available": True, "accountId": acct, "nodes": out}


def capture_vacation(client: JmapAuxClient, log: Any) -> dict[str, Any]:
    using = [JMAP_URN_CORE, URN_VACATION]
    try:
        acct = client.primary_account_id(URN_VACATION)
    except JmapError as e:
        log("warn", f"vacation: no account ({e}) — skipping surface")
        return {"available": False, "response": None}

    res = client.call_one(using, "VacationResponse/get", {"accountId": acct, "ids": None})
    lst = res.get("list", []) or []
    return {
        "available": True,
        "accountId": acct,
        "response": lst[0] if lst else None,
    }


# ── runner ─────────────────────────────────────────────────────────────────


def _safe_address(address: str) -> str:
    """Produce a filesystem-safe segment from an email address. The mail
    scripts use the same convention so .aux/ sits as a sibling of cur/."""
    return address.replace("/", "_")


def run(args: argparse.Namespace) -> int:
    address = args.account_address
    master = args.master_user
    password = read_password_env(args.auth_pass_env)
    endpoint = args.endpoint

    output_root = args.output_dir
    addr_dir = os.path.join(output_root, _safe_address(address))
    aux_dir = os.path.join(addr_dir, ".aux")
    os.makedirs(aux_dir, exist_ok=True)

    def log(level: str, msg: str) -> None:
        print(f"AUX_SYNC {level.upper()} addr={address} {msg}", file=sys.stderr, flush=True)

    client = make_client(endpoint, address, master, password)
    t0 = time.time()
    try:
        client.session()
    except JmapError as e:
        log("error", f"session: {e}")
        return 3

    surfaces: dict[str, dict[str, Any]] = {}
    failed: list[str] = []

    for name, fn in [
        ("sieve", capture_sieve),
        ("contacts", capture_contacts),
        ("calendar", capture_calendars),
        ("vacation", capture_vacation),
        ("filenode", capture_filenode),
    ]:
        try:
            surfaces[name] = fn(client, log)
        except JmapError as e:
            log("error", f"{name}: {e}")
            surfaces[name] = {"available": False, "error": str(e)}
            failed.append(name)
        except Exception as e:  # noqa: BLE001 — best-effort + record
            log("error", f"{name}: unexpected {type(e).__name__}: {e}")
            surfaces[name] = {"available": False, "error": f"{type(e).__name__}: {e}"}
            failed.append(name)

    # Write each surface to its own JSON file (atomic via .tmp rename).
    for name, payload in surfaces.items():
        path = os.path.join(aux_dir, f"{name}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    # Manifest captures counts + the master FQ so restore can sanity-check.
    manifest = {
        "address": address,
        "captured_at": int(time.time()),
        "master": master,
        "endpoint": endpoint,
        "surfaces": {
            "sieve":    {"available": surfaces["sieve"].get("available", False),
                         "count": len(surfaces["sieve"].get("scripts", []))},
            "contacts": {"available": surfaces["contacts"].get("available", False),
                         "addressbooks": len(surfaces["contacts"].get("addressbooks", [])),
                         "cards": len(surfaces["contacts"].get("cards", []))},
            "calendar": {"available": surfaces["calendar"].get("available", False),
                         "calendars": len(surfaces["calendar"].get("calendars", [])),
                         "events": len(surfaces["calendar"].get("events", []))},
            "vacation": {"available": surfaces["vacation"].get("available", False),
                         "present": surfaces["vacation"].get("response") is not None},
            "filenode": {"available": surfaces["filenode"].get("available", False),
                         "nodes": len(surfaces["filenode"].get("nodes", []))},
        },
    }
    with open(os.path.join(aux_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # JSON summary line on stdout for orchestrator parsing.
    summary = {
        "kind": "aux",
        "address": address,
        "elapsed_s": round(time.time() - t0, 3),
        "manifest": manifest["surfaces"],
        "failed": failed,
    }
    print(json.dumps(summary, separators=(",", ":")), flush=True)
    print(
        f"AUX_DONE addr={address} sieve={manifest['surfaces']['sieve']['count']} "
        f"cards={manifest['surfaces']['contacts']['cards']} "
        f"events={manifest['surfaces']['calendar']['events']} "
        f"vacation={'yes' if manifest['surfaces']['vacation']['present'] else 'no'} "
        f"files={manifest['surfaces']['filenode']['nodes']} "
        f"failed={','.join(failed) if failed else 'none'}",
        file=sys.stderr,
    )

    return 4 if failed else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--endpoint", required=True,
                   help="Stalwart JMAP endpoint base URL "
                        "(e.g. http://stalwart-mgmt.mail.svc.cluster.local:8080)")
    p.add_argument("--account-address", required=True,
                   help="The mailbox address being captured (e.g. user@example.com)")
    p.add_argument("--master-user", required=True,
                   help="Master principal FQ (e.g. master@<apex>)")
    p.add_argument("--auth-pass-env", required=True,
                   help="Env var holding the master password "
                        "(e.g. STALWART_MASTER_PASSWORD)")
    p.add_argument("--output-dir", required=True,
                   help="Root output dir. Aux JSON written to "
                        "<output-dir>/<address>/.aux/")
    args = p.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
