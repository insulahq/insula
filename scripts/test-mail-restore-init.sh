#!/usr/bin/env bash
# Runs the REAL Stalwart and Bulwark `restore-state` init-container scripts —
# rendered from the manifests the way Flux renders them ($$ → $) — inside the
# tenant-backup-tools image they run in, across the restore scenarios:
# standby copy (generation and old layout) × restic snapshot newer/older/absent
# × restic failing × per-snapshot restore × existing data.
#
# Run: TOOLS_IMAGE=<tenant-backup-tools image> ./scripts/test-mail-restore-init.sh
# Needs docker. Build the image from this checkout first, e.g.
#   docker build -t local/tenant-backup-tools:test images/tenant-backup-tools
# (the scripts under test call standby-restore-pick.sh FROM THE IMAGE).
#
# Stubs: `restic` (scripted per scenario), `sleep` (no waiting between restic
# retries). Everything else — sh, cp, flock, realpath, python3 — is the image's.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE="${TOOLS_IMAGE:?set TOOLS_IMAGE to a tenant-backup-tools image built from this checkout}"
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"
CTR="restore-init-test-$$"
trap 'docker rm -f "$CTR" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

# ── Render the init scripts ────────────────────────────────────────────────
python3 - "$REPO_ROOT" "$WORK" <<'PY'
import sys, yaml
root, out = sys.argv[1], sys.argv[2]
for path, name in [("k8s/base/stalwart-mail/stalwart/deployment.yaml", "stalwart"),
                   ("k8s/base/bulwark/deployment.yaml", "bulwark")]:
    for doc in yaml.safe_load_all(open(f"{root}/{path}")):
        if not doc or doc.get("kind") != "Deployment":
            continue
        for c in doc["spec"]["template"]["spec"].get("initContainers", []):
            if c["name"] != "restore-state":
                continue
            cmd, args = c.get("command", []), c.get("args", [])
            script = cmd[2] if len(cmd) > 2 else args[0]
            # Flux postBuild substitution turns $$ into a literal $.
            open(f"{out}/{name}-restore.sh", "w").write(script.replace("$$", "$"))
PY
[ -s "$WORK/stalwart-restore.sh" ] && [ -s "$WORK/bulwark-restore.sh" ] || { echo "could not render the init scripts" >&2; exit 1; }

# ── Stubs + scenario helpers (run inside the container) ─────────────────────
mkdir -p "$WORK/stub"
cat > "$WORK/stub/restic" <<'STUB'
#!/bin/sh
# FAKE_SNAPSHOT_EPOCH: newest snapshot time (unset = empty repo)
# FAKE_PROBE_RC: exit of `restic snapshots --latest 1 --quiet`
# FAKE_RESTORE_RC: exit of `restic restore`
case "$*" in
  *restore*)
    [ "${FAKE_RESTORE_RC:-0}" = 0 ] || exit "$FAKE_RESTORE_RC"
    tgt=""; prev=""; for a in "$@"; do [ "$prev" = "--target" ] && tgt="$a"; prev="$a"; done
    mkdir -p "$tgt/var/lib/mail-stack/stalwart" "$tgt/var/lib/mail-stack/bulwark/admin"
    echo x > "$tgt/var/lib/mail-stack/stalwart/CURRENT"
    echo restic > "$tgt/var/lib/mail-stack/stalwart/SOURCE"
    echo restic > "$tgt/var/lib/mail-stack/bulwark/admin/admin.json"
    exit 0 ;;
  *--quiet*) exit "${FAKE_PROBE_RC:-0}" ;;
  *--json*)
    if [ -n "${FAKE_SNAPSHOT_EPOCH:-}" ]; then
      t=$(date -u -d "@$FAKE_SNAPSHOT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
      printf '[{"time":"%s","short_id":"abcdef12"}]' "$t"
    else
      printf '[]'
    fi ;;
esac
exit 0
STUB
printf '#!/bin/sh\nexit 0\n' > "$WORK/stub/sleep"
chmod +x "$WORK/stub/restic" "$WORK/stub/sleep"

cat > "$WORK/scenario.sh" <<'SCEN'
#!/bin/sh
# scenario.sh <stalwart|bulwark> <standby: gen|gen-stale|legacy|none> [existing]
# Env passes through to the init script (RESTIC_REPOSITORY, FAKE_*, …).
which="$1" standby="$2" existing="${3:-}"
now=$(date +%s)
rm -rf /standby-data /var/lib/stalwart/data /app/data /restore-tmp /podinfo
mkdir -p /standby-data /var/lib/stalwart/data /app/data /podinfo
echo true > /podinfo/allow-restore
[ -n "${RESTORE_ID:-}" ] && echo "$RESTORE_ID" > /podinfo/restore-snapshot-id
mk_copy() {  # <dir> — a standby copy of both halves, tagged as such
  mkdir -p "$1/stalwart" "$1/bulwark/admin"
  echo x > "$1/stalwart/CURRENT"; echo standby > "$1/stalwart/SOURCE"
  echo standby > "$1/bulwark/admin/admin.json"
}
case "$standby" in
  gen|gen-stale)
    epoch=$((now - 60)); [ "$standby" = gen-stale ] && epoch=$((now - 86400))
    mk_copy "/standby-data/gen/$epoch"
    ln -s "gen/$epoch" /standby-data/current
    ln -s current/stalwart /standby-data/stalwart; ln -s current/bulwark /standby-data/bulwark
    echo "$epoch" > /standby-data/.standby-complete; : > /standby-data/.lock ;;
  legacy)
    mk_copy /standby-data; echo $((now - 60)) > /standby-data/.standby-complete ;;
esac
if [ "$existing" = existing ]; then
  echo x > /var/lib/stalwart/data/CURRENT; echo existing > /var/lib/stalwart/data/SOURCE
  mkdir -p /app/data/admin; echo existing > /app/data/admin/admin.json
fi
PATH=/stub:$PATH sh "/tests/$which-restore.sh" > /tmp/out.log 2>&1
rc=$?
if [ "$which" = stalwart ]; then
  src=$(cat /var/lib/stalwart/data/SOURCE 2>/dev/null || echo empty)
else
  src=$(cat /app/data/admin/admin.json 2>/dev/null || echo empty)
fi
fresh=$( [ -f /var/lib/stalwart/data/.fresh-started-at ] || [ -f /app/data/.fresh-started-at ] && echo fresh-start || echo - )
echo "rc=$rc src=$src $fresh"
SCEN

docker rm -f "$CTR" >/dev/null 2>&1
docker run -d --name "$CTR" --user 0 --entrypoint sleep "$IMAGE" infinity >/dev/null
docker exec "$CTR" mkdir -p /tests /stub
docker cp "$WORK/stalwart-restore.sh" "$CTR:/tests/"
docker cp "$WORK/bulwark-restore.sh" "$CTR:/tests/"
docker cp "$WORK/scenario.sh" "$CTR:/tests/"
docker cp "$WORK/stub/." "$CTR:/stub/"

# run <component> <standby> [existing] [VAR=val ...] — prints the scenario's summary.
run() {
  local which="$1" standby="$2"; shift 2
  local existing=""
  if [ "${1:-}" = existing ]; then existing=existing; shift; fi
  local envs=()
  for kv in "$@"; do envs+=(-e "$kv"); done
  docker exec "${envs[@]}" "$CTR" sh /tests/scenario.sh "$which" "$standby" "$existing"
}
log_has() { docker exec "$CTR" grep -q "$1" /tmp/out.log; }
NOW=$(date +%s)
NEWER="FAKE_SNAPSHOT_EPOCH=$NOW"
OLDER="FAKE_SNAPSHOT_EPOCH=$((NOW - 3600))"

echo "── the read lock is taken before a generation is chosen ──"
for which in stalwart bulwark; do
  f="$WORK/$which-restore.sh"
  lock_line=$(grep -n 'flock -s' "$f" | head -1 | cut -d: -f1)
  pick_line=$(grep -n 'standby-restore-pick.sh' "$f" | grep -v '^[0-9]*: *#' | head -1 | cut -d: -f1)
  if [ -n "$lock_line" ] && [ -n "$pick_line" ] && [ "$lock_line" -lt "$pick_line" ]; then
    ok "$which: flock -s (line $lock_line) before the pick (line $pick_line)"
  else
    bad "$which: flock -s (line ${lock_line:-none}) must come before the pick (line ${pick_line:-none})"
  fi
done

echo "── Stalwart restore-state ──"
check "fresh standby copy, no backup → FAST PATH" "rc=0 src=standby -" "$(run stalwart gen)"
check "day-old standby copy, no backup → still the copy (was: FRESH START)" "rc=0 src=standby -" "$(run stalwart gen-stale)"
log_has "OLDER than the" && ok "…and the log says it is old" || bad "…and the log says it is old"
check "standby + an older snapshot → the copy" "rc=0 src=standby -" "$(run stalwart gen RESTIC_REPOSITORY=r "$OLDER")"
check "standby + a newer snapshot → restic" "rc=0 src=restic -" "$(run stalwart gen RESTIC_REPOSITORY=r "$NEWER")"
check "newer snapshot whose restore fails → falls back to the copy" "rc=0 src=standby -" "$(run stalwart gen RESTIC_REPOSITORY=r "$NEWER" FAKE_RESTORE_RC=1)"
log_has "falling back to the standby copy" && ok "…and says so" || bad "…and says so"
check "newer snapshot, repository unreachable at restore → falls back to the copy" "rc=0 src=standby -" "$(run stalwart gen RESTIC_REPOSITORY=r "$NEWER" FAKE_PROBE_RC=1)"
check "no standby copy, restore fails → crash-loops (no silent empty start)" "rc=1 src=empty -" "$(run stalwart none RESTIC_REPOSITORY=r "$NEWER" FAKE_RESTORE_RC=1)"
check "no standby copy, backup works → restic" "rc=0 src=restic -" "$(run stalwart none RESTIC_REPOSITORY=r "$NEWER")"
check "no standby copy, no backup → fresh start (as before)" "rc=0 src=empty fresh-start" "$(run stalwart none)"
check "per-snapshot restore ignores the standby copy" "rc=0 src=restic -" "$(run stalwart gen RESTIC_REPOSITORY=r "$OLDER" RESTORE_ID=abcdef12)"
check "the old in-place standby layout still restores" "rc=0 src=standby -" "$(run stalwart legacy)"
check "an existing DataStore is left alone" "rc=0 src=existing -" "$(run stalwart gen existing)"

echo "── Bulwark restore-state ──"
check "fresh standby copy, no backup → FAST PATH" "rc=0 src=standby -" "$(run bulwark gen)"
check "day-old standby copy, no backup → still the copy (was: fresh start, admin reset)" "rc=0 src=standby -" "$(run bulwark gen-stale)"
check "standby + an older snapshot → the copy" "rc=0 src=standby -" "$(run bulwark gen RESTIC_REPOSITORY=r "$OLDER")"
check "standby + a newer snapshot → restic" "rc=0 src=restic -" "$(run bulwark gen RESTIC_REPOSITORY=r "$NEWER")"
check "newer snapshot whose restore fails → falls back to the copy" "rc=0 src=standby -" "$(run bulwark gen RESTIC_REPOSITORY=r "$NEWER" FAKE_RESTORE_RC=1)"
check "no standby copy, no backup → fresh start (as before)" "rc=0 src=empty fresh-start" "$(run bulwark none)"
check "the old in-place standby layout still restores" "rc=0 src=standby -" "$(run bulwark legacy)"
check "an existing admin.json is left alone" "rc=0 src=existing -" "$(run bulwark gen existing)"

echo "── both halves agree ──"
s=$(run stalwart gen RESTIC_REPOSITORY=r "$NEWER"); b=$(run bulwark gen RESTIC_REPOSITORY=r "$NEWER")
check "same inputs → same source for Stalwart and Bulwark" "${s#rc=0 src=}" "${b#rc=0 src=}"

echo
echo "mail-restore-init: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
