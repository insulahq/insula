#!/usr/bin/env python3
"""
jmap-aux-restore.py — restore per-account auxiliary JMAP surfaces
captured by jmap-aux-sync.py.

Reads JSON sidecars under <maildir-root>/<address>/.aux/ and re-posts
each surface via the corresponding JMAP /set method:

    sieve.json     → Blob/upload + SieveScript/set
    contacts.json  → AddressBook/set + ContactCard/set
    calendar.json  → Calendar/set + CalendarEvent/set
    vacation.json  → VacationResponse/set

Restore mode (--mode):
    merge-skip-duplicates  Skip any object whose id already exists
                           server-side. Most permissive — re-runs
                           are idempotent. (Default.)
    merge-overwrite        Replace server-side state for matching ids
                           and create any that don't exist. New objects
                           keep their snapshot ids when permitted.
    replace                Destroy ALL existing aux state for this
                           account first, then create from the snapshot.
                           Requires --confirm-destructive.

Default mode for the platform's restore wizard is merge-skip-duplicates
— matches the mail restore default + has the same idempotency contract
(re-running the same restore is a no-op).

ID semantics: Stalwart accepts server-side ids in /set updates as the
target. Snapshots from a different cluster (DR scenario) may have id
collisions — merge-overwrite + replace handle that by overwriting.
merge-skip-duplicates surfaces a per-id skip count without erroring.

Auth model: master-user proxy (same as the mail scripts +
jmap-aux-sync.py).

Exit codes:
    0 — restore completed (some objects may have been skipped per --mode)
    2 — bad CLI / missing env
    3 — session failed
    4 — one or more surfaces partially failed (details on stderr)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from typing import Any, Optional

from jmap_aux_client import (  # noqa: E402
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


# ── per-surface restore ────────────────────────────────────────────────────


def _existing_ids(client: JmapAuxClient, using: list[str], method: str,
                  account_id: str) -> set[str]:
    """List server-side ids for the given /get method."""
    res = client.call_one(using, method, {"accountId": account_id, "ids": None,
                                          "properties": ["id"]})
    return {o.get("id") for o in res.get("list", []) if o.get("id")}


def _destroy_all(client: JmapAuxClient, using: list[str], set_method: str,
                 get_method: str, account_id: str, log: Any) -> int:
    ids = list(_existing_ids(client, using, get_method, account_id))
    if not ids:
        return 0
    # Destroy in chunks of 50 to stay well inside Stalwart's per-method
    # call ceiling (default 500 ops per /set, but auxiliary services
    # often have lower caps).
    destroyed = 0
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        res = client.call_one(using, set_method,
                              {"accountId": account_id, "destroy": chunk})
        not_destroyed = res.get("notDestroyed") or {}
        destroyed += len(chunk) - len(not_destroyed)
        if not_destroyed:
            log("warn", f"{set_method}: {len(not_destroyed)} not destroyed "
                        f"(first: {next(iter(not_destroyed.items()))})")
    return destroyed


def _destroy_filenodes_topologically(
    client: JmapAuxClient,
    using: list[str],
    account_id: str,
    log: Any,
) -> int:
    """Destroy every FileNode on the account, children before parents.

    Stalwart's FileNode/set/destroy rejects a non-empty folder with
    `nodeHasChildren: 'Cannot delete non-empty folder.'`. The generic
    `_destroy_all` issues ids in id-sorted batch order, which the
    Stalwart id space doesn't correlate with depth — so a parent
    folder can get attempted before its children, fail, and leave
    cruft behind. Worse, a partially-deleted `willDestroy` node holds
    the name slot, so the subsequent create-step collides with
    `invalidProperties: A node with the same name already exists`.

    Two-step fix:

      1. Fetch id + parentId for every node. Compute each node's
         depth in the tree (root = 0).
      2. Destroy in descending depth order (deepest children first).
         At each depth tier, batch into chunks of 50 to stay well
         under Stalwart's per-call op cap.

    Any node Stalwart still refuses to delete (concurrent activity,
    Stalwart-internal state) logs a WARN; the caller is expected to
    handle the resulting name collision on create (we fall back to
    `_try_update`).
    """
    # 1. Fetch all nodes with their parent linkage.
    get_res = client.call_one(
        using, "FileNode/get",
        {"accountId": account_id, "ids": None,
         "properties": ["id", "parentId"]},
    )
    nodes = get_res.get("list", []) or []
    if not nodes:
        return 0

    # 2. Build a depth map. Walk parentId → root for each node and
    #    count hops (cycles, if Stalwart ever permits them, terminate
    #    after `len(nodes)` hops to avoid infinite loops).
    by_id: dict[str, Optional[str]] = {n["id"]: n.get("parentId") for n in nodes}
    depth: dict[str, int] = {}

    def _depth(node_id: str, _seen: Optional[set[str]] = None) -> int:
        if node_id in depth:
            return depth[node_id]
        if _seen is None:
            _seen = set()
        if node_id in _seen:
            return 0  # cycle defense — treat as root-level
        _seen.add(node_id)
        parent = by_id.get(node_id)
        d = 0 if parent is None or parent not in by_id else _depth(parent, _seen) + 1
        depth[node_id] = d
        return d

    for n in nodes:
        _depth(n["id"])

    # 3. Sort deepest first, then destroy in 50-ops batches per tier.
    ordered = sorted(by_id.keys(), key=lambda nid: depth.get(nid, 0), reverse=True)
    destroyed = 0
    for i in range(0, len(ordered), 50):
        chunk = ordered[i:i + 50]
        try:
            res = client.call_one(using, "FileNode/set",
                                  {"accountId": account_id, "destroy": chunk})
        except JmapError as e:
            log("warn", f"FileNode/set destroy batch failed: {e}")
            continue
        not_destroyed = res.get("notDestroyed") or {}
        destroyed += len(chunk) - len(not_destroyed)
        if not_destroyed:
            sample = next(iter(not_destroyed.items()))
            log("warn", f"FileNode/set: {len(not_destroyed)} not destroyed "
                        f"(first: {sample})")
    return destroyed


def _drop_server_only_fields(obj: dict[str, Any], drop: set[str]) -> dict[str, Any]:
    """Remove server-managed fields (myRights, blobId, etc.) before /set.
    Stalwart rejects an update that includes them; the server controls
    those and computes them on response."""
    return {k: v for k, v in obj.items() if k not in drop}


def _try_create(client: JmapAuxClient, using: list[str], set_method: str,
                account_id: str, key: str, obj: dict[str, Any],
                log: Any) -> tuple[bool, str]:
    """Single-object create via /set. Returns (success, server_id_or_error)."""
    res = client.call_one(using, set_method,
                          {"accountId": account_id, "create": {key: obj}})
    created = res.get("created") or {}
    not_created = res.get("notCreated") or {}
    if key in created:
        return True, str(created[key].get("id") or key)
    err = not_created.get(key, {"type": "unknown"})
    log("warn", f"{set_method}/create {key!r} failed: {err.get('type')} "
                f"{err.get('description', '')[:120]}")
    return False, f"{err.get('type')}: {err.get('description', '')[:80]}"


def _try_update(client: JmapAuxClient, using: list[str], set_method: str,
                account_id: str, server_id: str, obj: dict[str, Any],
                log: Any) -> bool:
    res = client.call_one(using, set_method,
                          {"accountId": account_id,
                           "update": {server_id: obj}})
    updated = res.get("updated") or {}
    not_updated = res.get("notUpdated") or {}
    if server_id in updated:
        return True
    err = not_updated.get(server_id, {"type": "unknown"})
    log("warn", f"{set_method}/update {server_id!r} failed: {err.get('type')} "
                f"{err.get('description', '')[:120]}")
    return False


def _restore_object_list(
    *,
    client: JmapAuxClient,
    using: list[str],
    set_method: str,
    get_method: str,
    account_id: str,
    objects: list[dict[str, Any]],
    drop_fields: set[str],
    mode: str,
    log: Any,
) -> dict[str, int]:
    """Generic restore loop for ContactCard, CalendarEvent, Calendar,
    AddressBook, SieveScript. Returns counts per outcome."""
    if not objects:
        return {"input": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}

    existing = _existing_ids(client, using, get_method, account_id)
    created = updated = skipped = failed = 0
    for obj in objects:
        sid = obj.get("id")
        clean = _drop_server_only_fields(obj, drop_fields)
        # We always strip 'id' from the create payload — Stalwart assigns
        # its own. Track the snapshot id separately for merge-overwrite
        # lookup.
        clean_for_create = {k: v for k, v in clean.items() if k != "id"}

        if sid and sid in existing:
            if mode == "merge-skip-duplicates":
                skipped += 1
                continue
            if mode in ("merge-overwrite", "replace"):
                # In replace mode `existing` is empty (we just destroyed),
                # so this branch only fires under merge-overwrite.
                if _try_update(client, using, set_method, account_id, sid,
                               clean_for_create, log):
                    updated += 1
                else:
                    failed += 1
                continue

        # New (or replace mode with a fresh slate)
        ok, _ = _try_create(client, using, set_method, account_id,
                            key=sid or f"new-{created + failed}",
                            obj=clean_for_create, log=log)
        if ok:
            created += 1
        else:
            failed += 1
    return {"input": len(objects), "created": created, "updated": updated,
            "skipped": skipped, "failed": failed}


def restore_sieve(client: JmapAuxClient, payload: dict[str, Any],
                  mode: str, log: Any) -> dict[str, int]:
    using = [JMAP_URN_CORE, URN_SIEVE]
    if not payload.get("available"):
        return {"input": 0, "skipped": 0, "skipped_reason": "snapshot lacks surface"}
    try:
        acct = client.primary_account_id(URN_SIEVE)
    except JmapError as e:
        log("warn", f"sieve: target lacks surface ({e}) — skipping restore")
        return {"input": 0, "skipped": 0, "skipped_reason": "target lacks surface"}

    if mode == "replace":
        n = _destroy_all(client, using, "SieveScript/set", "SieveScript/get", acct, log)
        log("info", f"sieve: replace mode destroyed {n} pre-existing scripts")

    scripts = payload.get("scripts", []) or []
    if not scripts:
        return {"input": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}

    # Stalwart reserves a small set of internal script names; any
    # snapshot script with these names is silently rejected by
    # SieveScript/set/create with `forbidden`. List established empirically
    # against testing.phoenix-host.net 2026-05-22 — extend as new
    # reserved names surface in upstream.
    RESERVED_SIEVE_NAMES = {"vacation"}

    existing = _existing_ids(client, using, "SieveScript/get", acct)
    existing_names: dict[str, str] = {}
    try:
        ex_r = client.call_one(using, "SieveScript/get",
                               {"accountId": acct, "ids": None,
                                "properties": ["id", "name"]})
        existing_names = {s["name"]: s["id"] for s in ex_r.get("list", []) if s.get("name")}
    except JmapError:
        pass

    created = updated = skipped = failed = 0
    for s in scripts:
        sid = s.get("id")
        sname = s.get("name", "untitled")
        body_b64 = s.get("_body_b64")
        if not body_b64:
            log("warn", f"sieve script {sname!r}: no body — skipping")
            skipped += 1
            continue
        if sname in RESERVED_SIEVE_NAMES:
            log("info", f"sieve script {sname!r}: reserved name on target — skipping "
                        f"(target's auto-managed script of the same name remains intact)")
            skipped += 1
            continue
        # Name-collision fallback: in merge-overwrite mode the snapshot
        # may carry an id that doesn't exist on target but a different
        # script already has the same name — update that one by its
        # target-side id instead of failing with `alreadyExists`.
        target_sid_by_name = existing_names.get(sname)
        body = base64.b64decode(body_b64)

        if sid and sid in existing and mode == "merge-skip-duplicates":
            skipped += 1
            continue

        # Step 1: upload the script body as a blob.
        try:
            blob_id = client.blob_upload(acct, body, content_type="application/sieve")
        except JmapError as e:
            log("warn", f"sieve {s.get('name')!r} blob_upload failed: {e}")
            failed += 1
            continue

        # Step 2: SieveScript/set referencing that blob.
        sieve_obj = {
            "name": sname,
            "blobId": blob_id,
            "isActive": bool(s.get("isActive", False)),
        }
        # Prefer update by snapshot id; fall back to update by target name;
        # otherwise create.
        update_id: Optional[str] = None  # noqa: F821 — type alias import below if needed
        if sid and sid in existing:
            update_id = sid
        elif target_sid_by_name:
            update_id = target_sid_by_name
            log("info", f"sieve script {sname!r}: name collision on target id "
                        f"{target_sid_by_name!r} — updating in place")

        if update_id and mode in ("merge-skip-duplicates",):
            skipped += 1
            continue
        if update_id and mode in ("merge-overwrite", "replace"):
            if _try_update(client, using, "SieveScript/set", acct, update_id, sieve_obj, log):
                updated += 1
            else:
                failed += 1
        else:
            ok, _ = _try_create(client, using, "SieveScript/set", acct,
                                key=sid or f"new-{created + failed}",
                                obj=sieve_obj, log=log)
            if ok:
                created += 1
            else:
                failed += 1
    return {"input": len(scripts), "created": created, "updated": updated,
            "skipped": skipped, "failed": failed}


def restore_contacts(client: JmapAuxClient, payload: dict[str, Any],
                     mode: str, log: Any) -> dict[str, dict[str, int]]:
    """Stalwart auto-provisions a default AddressBook per account — we
    cannot create another by name (silently rejected as "field could
    not be set"). Strategy: find the target's default AddressBook id,
    build a {snapshot_id → target_id} map by matching `isDefault`,
    rewrite `addressBookIds` in every snapshot card to point at the
    target's default. Cards from non-default snapshot addressbooks land
    in the target's default too (we don't multiplex addressbooks on
    restore — operators who want that can manually create + reassign).
    """
    using = [JMAP_URN_CORE, URN_CONTACTS]
    if not payload.get("available"):
        return {"addressbooks": {"input": 0, "skipped_reason": "snapshot lacks surface"},
                "cards": {"input": 0, "skipped_reason": "snapshot lacks surface"}}
    try:
        acct = client.primary_account_id(URN_CONTACTS)
    except JmapError as e:
        log("warn", f"contacts: target lacks surface ({e}) — skipping restore")
        return {"addressbooks": {"input": 0, "skipped_reason": "target lacks surface"},
                "cards": {"input": 0, "skipped_reason": "target lacks surface"}}

    if mode == "replace":
        # Cards reference addressbookIds — destroy cards first.
        nc = _destroy_all(client, using, "ContactCard/set", "ContactCard/get", acct, log)
        # NB: don't destroy the default AddressBook — Stalwart re-creates
        # one on access. Destroy non-default ones only.
        log("info", f"contacts: replace mode destroyed cards={nc}")

    # Resolve target default addressbook id. Stalwart auto-provisions
    # one on the first AddressBook/get of an account that's seen any
    # CardDAV / JMAP-contacts activity, but a freshly-restored account
    # may have never been touched on the contacts surface — so we
    # create one explicitly if none exist.
    target_abs_r = client.call_one(using, "AddressBook/get",
                                   {"accountId": acct, "ids": None,
                                    "properties": ["id", "isDefault"]})
    target_abs = target_abs_r.get("list", []) or []
    target_default = next(
        (a["id"] for a in target_abs if a.get("isDefault")),
        target_abs[0]["id"] if target_abs else None,
    )
    if not target_default:
        log("info", "contacts: target has no addressbook — creating one for restore")
        cr = client.call_one(using, "AddressBook/set",
                             {"accountId": acct,
                              "create": {"k1": {"name": "Restored Contacts"}}})
        created_ab = cr.get("created", {}).get("k1", {})
        target_default = created_ab.get("id")
        if not target_default:
            log("error", f"contacts: failed to create addressbook on target: {cr}")
            return {"addressbooks": {"input": 0, "skipped_reason": "target addressbook create failed"},
                    "cards": {"input": 0, "skipped_reason": "target addressbook create failed"}}

    # Map every snapshot addressbook id to the target default. (Future
    # work: create non-default snapshot addressbooks too, when name
    # collision rules are documented.)
    snap_abs = payload.get("addressbooks", []) or []
    snap_to_target_ab = {a["id"]: target_default for a in snap_abs if a.get("id")}
    ab_result = {"input": len(snap_abs), "created": 0, "updated": 0,
                 "skipped": len(snap_abs), "failed": 0,
                 "note": f"all snapshot addressbooks mapped to target default {target_default}"}

    # Rewrite cards: addressBookIds, drop immutable + server-managed fields.
    snap_cards = payload.get("cards", []) or []
    rewritten: list[dict[str, Any]] = []
    for card in snap_cards:
        c = _drop_server_only_fields(card, {"myRights", "blobId"})
        old_ab_ids = c.get("addressBookIds") or {}
        c["addressBookIds"] = {
            snap_to_target_ab.get(k, target_default): v for k, v in old_ab_ids.items()
        } or {target_default: True}
        rewritten.append(c)

    cards = _restore_object_list(
        client=client, using=using,
        set_method="ContactCard/set", get_method="ContactCard/get",
        account_id=acct, objects=rewritten,
        drop_fields=set(),  # already cleaned above
        mode=mode, log=log,
    )
    return {"addressbooks": ab_result, "cards": cards}


def restore_calendars(client: JmapAuxClient, payload: dict[str, Any],
                      mode: str, log: Any) -> dict[str, dict[str, int]]:
    """Same auto-default + remap strategy as restore_contacts(). Also
    drop CalendarEvent.uid (immutable) and recompute calendarIds via
    the snapshot→target map.
    """
    using = [JMAP_URN_CORE, URN_CALENDARS]
    if not payload.get("available"):
        return {"calendars": {"input": 0, "skipped_reason": "snapshot lacks surface"},
                "events": {"input": 0, "skipped_reason": "snapshot lacks surface"}}
    try:
        acct = client.primary_account_id(URN_CALENDARS)
    except JmapError as e:
        log("warn", f"calendars: target lacks surface ({e}) — skipping restore")
        return {"calendars": {"input": 0, "skipped_reason": "target lacks surface"},
                "events": {"input": 0, "skipped_reason": "target lacks surface"}}

    if mode == "replace":
        ne = _destroy_all(client, using, "CalendarEvent/set", "CalendarEvent/get", acct, log)
        log("info", f"calendars: replace mode destroyed events={ne}")

    target_cals_r = client.call_one(using, "Calendar/get",
                                    {"accountId": acct, "ids": None,
                                     "properties": ["id", "isDefault"]})
    target_cals = target_cals_r.get("list", []) or []
    target_default = next(
        (c["id"] for c in target_cals if c.get("isDefault")),
        target_cals[0]["id"] if target_cals else None,
    )
    if not target_default:
        log("info", "calendars: target has no calendar — creating one for restore")
        cr = client.call_one(using, "Calendar/set",
                             {"accountId": acct,
                              "create": {"k1": {"name": "Restored Calendar"}}})
        created_cal = cr.get("created", {}).get("k1", {})
        target_default = created_cal.get("id")
        if not target_default:
            log("error", f"calendars: failed to create calendar on target: {cr}")
            return {"calendars": {"input": 0, "skipped_reason": "target calendar create failed"},
                    "events": {"input": 0, "skipped_reason": "target calendar create failed"}}

    snap_cals = payload.get("calendars", []) or []
    snap_to_target_cal = {c["id"]: target_default for c in snap_cals if c.get("id")}
    cal_result = {"input": len(snap_cals), "created": 0, "updated": 0,
                  "skipped": len(snap_cals), "failed": 0,
                  "note": f"all snapshot calendars mapped to target default {target_default}"}

    # Rewrite events: calendarIds, drop immutables / server-controlled.
    # Stalwart's set rejects @type, uid, isOrigin (computed) — confirmed
    # against testing.phoenix-host.net 2026-05-22. created, updated,
    # sequence may also be derived; drop them defensively.
    EVENT_IMMUTABLE = {
        "myRights", "uid", "isOrigin", "@type",
        "created", "updated", "sequence",
    }
    snap_events = payload.get("events", []) or []
    rewritten: list[dict[str, Any]] = []
    for ev in snap_events:
        e = _drop_server_only_fields(ev, EVENT_IMMUTABLE)
        old_cal_ids = e.get("calendarIds") or {}
        e["calendarIds"] = {
            snap_to_target_cal.get(k, target_default): v for k, v in old_cal_ids.items()
        } or {target_default: True}
        rewritten.append(e)

    events = _restore_object_list(
        client=client, using=using,
        set_method="CalendarEvent/set", get_method="CalendarEvent/get",
        account_id=acct, objects=rewritten,
        drop_fields=set(),
        mode=mode, log=log,
    )
    return {"calendars": cal_result, "events": events}


def restore_filenode(client: JmapAuxClient, payload: dict[str, Any],
                     mode: str, log: Any) -> dict[str, int]:
    """File storage restore. Folders are flat objects ({name}); files
    have an inline base64 body which we re-upload via Blob/upload first.

    Order matters: in the snapshot, child nodes reference parentId of
    a folder that may not exist yet on the target. We do a two-pass:
    folders first (sorted so parents precede children), then files.
    Stalwart's id space is per-account, so the snapshot ids may
    collide on the target — merge-overwrite uses /update by id,
    merge-skip-duplicates skips on id collision, replace destroys all
    first.
    """
    import base64
    using = [JMAP_URN_CORE, URN_FILENODE]
    if not payload.get("available"):
        return {"input": 0, "skipped_reason": "snapshot lacks surface"}
    try:
        acct = client.primary_account_id(URN_FILENODE)
    except JmapError as e:
        log("warn", f"filenode: target lacks surface ({e}) — skipping restore")
        return {"input": 0, "skipped_reason": "target lacks surface"}

    if mode == "replace":
        n = _destroy_filenodes_topologically(client, using, acct, log)
        log("info", f"filenode: replace mode destroyed {n} pre-existing nodes "
                    f"(topological order — children before parents)")

    nodes = payload.get("nodes", []) or []
    if not nodes:
        return {"input": 0, "created": 0, "updated": 0, "skipped": 0, "failed": 0}

    existing = _existing_ids(client, using, "FileNode/get", acct)
    # Folders first, then files (parents before children).
    folders = [n for n in nodes if not n.get("blobId") and not n.get("_body_b64")]
    files = [n for n in nodes if n.get("blobId") or n.get("_body_b64")]

    # Track snapshot folder id → newly-created target id so children
    # can rewrite their parentId. Files keep the same map (they may
    # parent additional files in some setups, though rare).
    snap_to_target: dict[str, str] = {}
    created = updated = skipped = failed = 0

    for n in folders + files:
        sid = n.get("id")
        body_b64 = n.get("_body_b64")
        # Re-upload body if this is a file.
        new_blob_id: Optional[str] = None
        if body_b64:
            try:
                body = base64.b64decode(body_b64)
                new_blob_id = client.blob_upload(acct, body,
                                                 content_type="application/octet-stream")
            except JmapError as e:
                log("warn", f"filenode {n.get('name')!r} blob_upload failed: {e}")
                failed += 1
                continue

        obj: dict[str, Any] = {"name": n.get("name", "untitled")}
        if new_blob_id:
            obj["blobId"] = new_blob_id
        # Remap parentId via snap_to_target. If the snapshot parent isn't
        # in the map (e.g. orphaned reference), drop it — Stalwart will
        # place the node at root.
        snap_parent = n.get("parentId")
        if snap_parent and snap_parent in snap_to_target:
            obj["parentId"] = snap_to_target[snap_parent]
        elif snap_parent:
            log("info", f"filenode {n.get('name')!r}: snapshot parentId "
                        f"{snap_parent!r} not in remap table — placing at root")

        if sid and sid in existing:
            if mode == "merge-skip-duplicates":
                skipped += 1
                if sid:
                    snap_to_target[sid] = sid  # identity remap for skipped
                continue
            if mode == "merge-overwrite":
                if _try_update(client, using, "FileNode/set", acct, sid, obj, log):
                    updated += 1
                    if sid:
                        snap_to_target[sid] = sid
                else:
                    failed += 1
                continue

        ok, server_id = _try_create(client, using, "FileNode/set", acct,
                                     key=sid or f"new-{created + failed}",
                                     obj=obj, log=log)
        if ok:
            created += 1
            if sid:
                snap_to_target[sid] = server_id
        else:
            failed += 1

    return {"input": len(nodes), "created": created, "updated": updated,
            "skipped": skipped, "failed": failed}


def restore_vacation(client: JmapAuxClient, payload: dict[str, Any],
                     mode: str, log: Any) -> dict[str, Any]:
    using = [JMAP_URN_CORE, URN_VACATION]
    if not payload.get("available") or not payload.get("response"):
        return {"input": 0, "skipped_reason": "no snapshot data"}
    try:
        acct = client.primary_account_id(URN_VACATION)
    except JmapError as e:
        log("warn", f"vacation: target lacks surface ({e}) — skipping restore")
        return {"input": 0, "skipped_reason": "target lacks surface"}

    snap = payload["response"]
    sid = snap.get("id", "singleton")
    clean = _drop_server_only_fields(snap, {"id"})

    if mode == "merge-skip-duplicates":
        # Vacation response is a singleton — if one exists already, skip.
        existing = _existing_ids(client, using, "VacationResponse/get", acct)
        if existing:
            return {"input": 1, "skipped": 1, "skipped_reason": "singleton present + merge-skip mode"}

    ok = _try_update(client, using, "VacationResponse/set", acct, sid, clean, log)
    return {"input": 1, "updated": 1 if ok else 0, "failed": 0 if ok else 1}


# ── runner ─────────────────────────────────────────────────────────────────


def _safe_address(address: str) -> str:
    return address.replace("/", "_")


def _load_sidecar(aux_dir: str, name: str) -> dict[str, Any] | None:
    path = os.path.join(aux_dir, f"{name}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run(args: argparse.Namespace) -> int:
    address = args.target_address
    source_address = args.source_address or address
    master = args.master_user
    password = read_password_env(args.auth_pass_env)
    endpoint = args.endpoint

    mode = args.mode
    if mode not in ("merge-skip-duplicates", "merge-overwrite", "replace"):
        print(f"FATAL: --mode must be merge-skip-duplicates|merge-overwrite|replace, got {mode!r}",
              file=sys.stderr)
        return 2
    if mode == "replace" and not args.confirm_destructive:
        print("FATAL: --mode replace requires --confirm-destructive", file=sys.stderr)
        return 2

    aux_dir = os.path.join(args.maildir_root, _safe_address(source_address), ".aux")
    if not os.path.isdir(aux_dir):
        print(f"AUX_RESTORE INFO addr={address} no .aux dir at {aux_dir} — skipping aux restore",
              file=sys.stderr)
        print(json.dumps({"kind": "aux", "address": address, "skipped": True,
                          "reason": "no .aux sidecar"}), flush=True)
        return 0

    def log(level: str, msg: str) -> None:
        print(f"AUX_RESTORE {level.upper()} addr={address} {msg}",
              file=sys.stderr, flush=True)

    client = make_client(endpoint, address, master, password)
    t0 = time.time()
    try:
        client.session()
    except JmapError as e:
        log("error", f"session: {e}")
        return 3

    failed: list[str] = []
    outcome: dict[str, Any] = {}

    sieve_payload = _load_sidecar(aux_dir, "sieve")
    if sieve_payload:
        try:
            outcome["sieve"] = restore_sieve(client, sieve_payload, mode, log)
        except Exception as e:  # noqa: BLE001
            log("error", f"sieve: unexpected {type(e).__name__}: {e}")
            outcome["sieve"] = {"failed": 1, "error": str(e)}
            failed.append("sieve")

    contacts_payload = _load_sidecar(aux_dir, "contacts")
    if contacts_payload:
        try:
            outcome["contacts"] = restore_contacts(client, contacts_payload, mode, log)
        except Exception as e:  # noqa: BLE001
            log("error", f"contacts: unexpected {type(e).__name__}: {e}")
            outcome["contacts"] = {"failed": 1, "error": str(e)}
            failed.append("contacts")

    calendar_payload = _load_sidecar(aux_dir, "calendar")
    if calendar_payload:
        try:
            outcome["calendar"] = restore_calendars(client, calendar_payload, mode, log)
        except Exception as e:  # noqa: BLE001
            log("error", f"calendar: unexpected {type(e).__name__}: {e}")
            outcome["calendar"] = {"failed": 1, "error": str(e)}
            failed.append("calendar")

    filenode_payload = _load_sidecar(aux_dir, "filenode")
    if filenode_payload:
        try:
            outcome["filenode"] = restore_filenode(client, filenode_payload, mode, log)
        except Exception as e:  # noqa: BLE001
            log("error", f"filenode: unexpected {type(e).__name__}: {e}")
            outcome["filenode"] = {"failed": 1, "error": str(e)}
            failed.append("filenode")

    vacation_payload = _load_sidecar(aux_dir, "vacation")
    if vacation_payload:
        try:
            outcome["vacation"] = restore_vacation(client, vacation_payload, mode, log)
        except Exception as e:  # noqa: BLE001
            log("error", f"vacation: unexpected {type(e).__name__}: {e}")
            outcome["vacation"] = {"failed": 1, "error": str(e)}
            failed.append("vacation")

    summary = {
        "kind": "aux",
        "address": address,
        "elapsed_s": round(time.time() - t0, 3),
        "mode": mode,
        "outcome": outcome,
        "failed": failed,
    }
    print(json.dumps(summary, separators=(",", ":")), flush=True)
    print(f"AUX_RESTORE DONE addr={address} outcomes={list(outcome.keys())} "
          f"failed={','.join(failed) if failed else 'none'}",
          file=sys.stderr)
    return 4 if failed else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--endpoint", required=True)
    p.add_argument("--target-address", required=True,
                   help="Account to restore into")
    p.add_argument("--source-address",
                   help="Address whose .aux/ directory holds the snapshot "
                        "(defaults to --target-address)")
    p.add_argument("--master-user", required=True)
    p.add_argument("--auth-pass-env", required=True)
    p.add_argument("--maildir-root", required=True,
                   help="Root of the extracted Maildir tarball; .aux/ lives "
                        "at <maildir-root>/<source-address>/.aux/")
    p.add_argument("--mode", default="merge-skip-duplicates",
                   choices=["merge-skip-duplicates", "merge-overwrite", "replace"])
    p.add_argument("--confirm-destructive", action="store_true",
                   help="Required when --mode=replace")
    args = p.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
