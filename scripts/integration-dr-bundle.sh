#!/usr/bin/env bash
# integration-dr-bundle.sh — A2 end-to-end verification of the DR
# bundle sidecars (dr-inputs.yaml + dr-rows.json) inside every
# secrets-bundle export.
#
# Verifies:
#   A1. POST /system-backup/secrets/export creates a run.
#   A2. The run completes (status=succeeded) within timeout.
#   A3. The bundle download URL works.
#   B1. The downloaded payload is a valid age ciphertext.
#   B2. age -d -i <operator-private-key> decrypts to a tar archive.
#   C1. The decrypted tar contains MANIFEST.txt + MANIFEST.json
#       (regression — pre-A2 behaviour).
#   C2. The decrypted tar contains dr-inputs.yaml (A2 addition).
#   C3. The decrypted tar contains dr-rows.json (A2 addition).
#   D1. dr-inputs.yaml has drBundleVersion=1 + apexDomain populated.
#   D2. dr-inputs.yaml's mailPortMode is one of haproxy|hostport.
#   D3. dr-inputs.yaml's bundleTopology is one of single|ha.
#   E1. dr-rows.json has drBundleVersion=1.
#   E2. EVERY backup_configurations row in dr-rows.json has
#       readOnly:true (the critical contract — Unit B's importer
#       relies on this).
#   F1. The Critical-Secret list (PLATFORM_ENCRYPTION_KEY +
#       backup-target-key) is present in the tar — checked by
#       grepping for the well-known YAML filenames.
#
# Env:
#   ADMIN_HOST       — defaults to https://admin.staging.example.test
#   ADMIN_EMAIL      — defaults to admin@example.test
#   ADMIN_PASSWORD   — required if no INTEGRATION_TOKEN cache.
#   AGE_KEY_FILE     — path to operator AGE private key (defaults to
#                      ~/k8s-staging/<env>-age.key). REQUIRED for B2+.
#   CURL_INSECURE    — set 1 to ignore TLS errors

# resolve_platform_apex(): derive the test apex instead of baking one in.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
AGE_KEY_FILE="${AGE_KEY_FILE:-$HOME/k8s-staging/staging-age.key}"
CURL_OPTS=(-s --max-time 120)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then
  CURL_OPTS+=(-k)
fi

# shellcheck disable=SC1090
source "$(dirname "$0")/lib/integration-token.sh"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # Phase H invokes scripts/dr-restore-bundle.sh

WORK_DIR=$(mktemp -d -t dr-bundle-XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok() { echo "  ✅ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $*" >&2; FAIL=$((FAIL + 1)); }

# ─── Auth ───────────────────────────────────────────────────────────
# get_integration_token was removed when lib/integration-token.sh was refactored
# (#130) to cached_or_login_token + a caller-defined login_token(). Provide it.
login_token() {
  if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
    echo "ERROR: ADMIN_PASSWORD unset and INTEGRATION_TOKEN absent" >&2; return 1
  fi
  curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL:-admin@example.test}\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | sed -nE 's/.*"token":"([^"]+)".*/\1/p'
}
echo "==> Phase A: trigger export run + wait for success"
TOKEN=$(cached_or_login_token)
if [[ -z "$TOKEN" ]]; then
  fail "no auth token"
  exit 1
fi

# A1 — POST export
TRIGGER=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/system-backup/secrets/export" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"integration-dr-bundle.sh"}')
RUN_ID=$(echo "$TRIGGER" | jq -r '.data.runId // empty')
if [[ -z "$RUN_ID" ]]; then
  fail "POST export did not return runId: $TRIGGER"
  exit 1
fi
ok "A1 export run created: $RUN_ID"

# A2 — Poll until succeeded
DEADLINE=$(( $(date +%s) + 180 ))
STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" \
    "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID" | jq -r '.data.status')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    fail "A2 export failed: $(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID")"
    exit 1
  fi
  sleep 3
done
if [[ "$STATUS" != "succeeded" ]]; then
  fail "A2 export did not reach succeeded in 180s (last=$STATUS)"
  exit 1
fi
ok "A2 export reached status=succeeded"

# A3 — Download URL
DOWNLOAD_URL=$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID" | jq -r '.data.downloadUrl')
if [[ -z "$DOWNLOAD_URL" || "$DOWNLOAD_URL" == "null" ]]; then
  fail "A3 no downloadUrl in run record"
  exit 1
fi
# downloadUrl is a relative path (/api/v1/system-backup/secrets/runs/:id/download,
# a one-shot signed URL) — prefix ADMIN_HOST unless the backend returns absolute.
case "$DOWNLOAD_URL" in http*) DL_URL="$DOWNLOAD_URL" ;; *) DL_URL="${ADMIN_HOST%/}${DOWNLOAD_URL}" ;; esac
curl "${CURL_OPTS[@]}" -o "$WORK_DIR/bundle.age" "$DL_URL"
if [[ ! -s "$WORK_DIR/bundle.age" ]]; then
  fail "A3 download produced empty file"
  exit 1
fi
ok "A3 download produced $(stat -c%s "$WORK_DIR/bundle.age") bytes"

# ─── Decrypt ────────────────────────────────────────────────────────
echo "==> Phase B: decrypt + untar"
# External-tier prerequisites: the `age` binary + the operator's AGE private
# key. Absent on a public clone / CI without the operator's secrets, so SKIP
# (77) rather than FAIL — this suite decrypts a real operator bundle and only
# runs where that key is provisioned (matches the other external-tier suites).
if ! command -v age >/dev/null 2>&1; then
  echo "  SKIP (77): 'age' binary not on PATH — external-tier bundle-decrypt suite. Install age (apt-get install age / filippo.io/age) to run." >&2
  exit 77
fi
# Fall back to the key the CLUSTER ITSELF generated before declaring the suite
# unrunnable. bootstrap.sh writes the operator AGE keypair to
# /var/lib/insula/operator-key/ on the control plane, so the key that can decrypt
# this cluster's bundle is always on the cluster this suite is already SSH'd
# into. The old default was a hardcoded personal path
# ($HOME/k8s-staging/staging-age.key) that exists on nobody else's machine, so
# the suite skipped everywhere but one workstation — and it skipped AFTER
# exporting and downloading a real 200KB+ bundle, i.e. it did the expensive part
# and then threw the result away.
#
# Copied to a 0600 file inside WORK_DIR (already rm -rf'd by the EXIT trap) so
# the private key never persists on the harness, and never to stdout.
if [[ ! -f "$AGE_KEY_FILE" && -n "${SSH_HOST:-}" ]]; then
  _node_key=/var/lib/insula/operator-key/operator-private.key
  _fetched="$WORK_DIR/operator-age.key"
  if (umask 077; ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
        -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o LogLevel=ERROR \
        "$SSH_HOST" "cat $_node_key" > "$_fetched" 2>/dev/null) \
     && grep -q 'AGE-SECRET-KEY' "$_fetched"; then
    chmod 600 "$_fetched"
    AGE_KEY_FILE="$_fetched"
    echo "  • AGE key not at the configured path — using the cluster's own operator key from ${SSH_HOST#*@}:$_node_key (temporary, 0600, removed on exit)"
  else
    rm -f "$_fetched"
  fi
fi
if [[ ! -f "$AGE_KEY_FILE" ]]; then
  echo "  SKIP (77): no operator AGE private key — not at \$AGE_KEY_FILE ($AGE_KEY_FILE) and could not read /var/lib/insula/operator-key/operator-private.key from \${SSH_HOST:-<unset>}. Set AGE_KEY_FILE or give the harness SSH access to the control plane." >&2
  exit 77
fi

# B1 — looks like an age file (magic = "age-encryption.org/v1")
if ! head -c 22 "$WORK_DIR/bundle.age" | grep -q "age-encryption.org/v1"; then
  fail "B1 payload does not start with age v1 magic"
  exit 1
fi
ok "B1 payload starts with age v1 magic"

# B2 — decrypt
if ! age -d -i "$AGE_KEY_FILE" -o "$WORK_DIR/bundle.tar" "$WORK_DIR/bundle.age"; then
  fail "B2 age decrypt failed"
  exit 1
fi
ok "B2 age decrypt produced tar"

# Untar to work dir
mkdir -p "$WORK_DIR/contents"
tar -xf "$WORK_DIR/bundle.tar" -C "$WORK_DIR/contents"

# ─── Sidecar presence ───────────────────────────────────────────────
echo "==> Phase C: sidecar presence"
for f in MANIFEST.txt MANIFEST.json; do
  if [[ -s "$WORK_DIR/contents/$f" ]]; then
    ok "C1 $f present"
  else
    fail "C1 $f missing or empty"
  fi
done
for f in dr-inputs.yaml dr-rows.json; do
  if [[ -s "$WORK_DIR/contents/$f" ]]; then
    ok "C2/C3 $f present"
  else
    fail "C2/C3 $f missing or empty"
  fi
done

# ─── dr-inputs.yaml content ─────────────────────────────────────────
echo "==> Phase D: dr-inputs.yaml content"
# dr-inputs.yaml carries only top-level scalars, so a missing `yq` is no reason
# to skip a DR assertion — PyYAML reads the same file, and every harness that
# runs this suite has python3. Phase D used to skip outright wherever yq was
# absent (this sandbox included), which is precisely the kind of permanent hole
# a disaster-recovery suite must not have.
y_get() {  # $1 = key, $2 = file
  if command -v yq >/dev/null 2>&1; then
    yq -r ".$1" "$2"
  else
    python3 -c 'import sys, yaml
d = yaml.safe_load(open(sys.argv[2])) or {}
v = d.get(sys.argv[1])
print("null" if v is None else v)' "$1" "$2"
  fi
}
if ! command -v yq >/dev/null 2>&1 && ! python3 -c 'import yaml' >/dev/null 2>&1; then
  fail "D needs a YAML reader — install yq or python3-yaml (refusing to skip a DR assertion)"
else
  VERSION=$(y_get drBundleVersion "$WORK_DIR/contents/dr-inputs.yaml")
  if [[ "$VERSION" == "1" ]]; then ok "D1 drBundleVersion=1"; else fail "D1 drBundleVersion=$VERSION (expected 1)"; fi
  APEX=$(y_get apexDomain "$WORK_DIR/contents/dr-inputs.yaml")
  if [[ -n "$APEX" && "$APEX" != "null" ]]; then ok "D1 apexDomain=$APEX"; else fail "D1 apexDomain empty"; fi
  MODE=$(y_get mailPortMode "$WORK_DIR/contents/dr-inputs.yaml")
  case "$MODE" in
    haproxy|hostport) ok "D2 mailPortMode=$MODE" ;;
    *) fail "D2 mailPortMode=$MODE (expected haproxy|hostport)" ;;
  esac
  TOPO=$(y_get bundleTopology "$WORK_DIR/contents/dr-inputs.yaml")
  case "$TOPO" in
    single|ha) ok "D3 bundleTopology=$TOPO" ;;
    *) fail "D3 bundleTopology=$TOPO (expected single|ha)" ;;
  esac
fi

# ─── dr-rows.json content ───────────────────────────────────────────
echo "==> Phase E: dr-rows.json content"
VERSION=$(jq -r '.drBundleVersion' "$WORK_DIR/contents/dr-rows.json")
if [[ "$VERSION" == "1" ]]; then ok "E1 drBundleVersion=1"; else fail "E1 drBundleVersion=$VERSION (expected 1)"; fi

# E2 — every config row carries readOnly:true. This is the critical
# contract Unit B's importer relies on; a bundle violating it would
# defeat the entire DR-safety mechanism.
NON_RO_COUNT=$(jq -r '[.backupConfigurations[] | select(.readOnly != true)] | length' "$WORK_DIR/contents/dr-rows.json")
if [[ "$NON_RO_COUNT" == "0" ]]; then
  TOTAL=$(jq -r '.backupConfigurations | length' "$WORK_DIR/contents/dr-rows.json")
  ok "E2 every backup_configurations row has readOnly:true ($TOTAL rows)"
else
  fail "E2 $NON_RO_COUNT row(s) in dr-rows.json have readOnly!=true — Unit B would refuse to import"
fi

# ─── Critical Secret presence ───────────────────────────────────────
echo "==> Phase F: critical Secret presence"
# The CRITICAL_TIER_1_SECRETS list in secrets-tiers.ts; filenames in
# the tar are <namespace>__<name>.yaml.
for crit in platform__platform-secrets.yaml platform__backup-target-key.yaml; do
  if [[ -f "$WORK_DIR/contents/$crit" ]]; then
    ok "F1 $crit present"
  else
    fail "F1 $crit MISSING — bundle would be unrestorable (PLATFORM_ENCRYPTION_KEY or BACKUP_TARGET_KEY absent)"
  fi
done

# ─── Restore round-trip (Unit B) ────────────────────────────────────
#
# Phase G validates the dr-restore-bundle.sh importer can consume the
# bundle we just produced + populate an empty DB with the right rows.
# Uses a throwaway local Postgres (docker run) so the live system-db
# stays clean. Skipped when --skip-restore is set OR docker is missing.
echo "==> Phase G: DR restore round-trip (on the node, via the insula CLI)"
#
# Runs the REAL restore path: the signed operator binary, the real schema
# migrations, and a real Postgres — the same CNPG cluster the platform uses,
# but restoring into an ISOLATED throwaway database that is dropped afterwards.
#
# It used to spin up an ephemeral Postgres through the HARNESS's docker and
# skipped whenever the harness could not reach the published port — which is the
# case from a sandbox whose docker lives in another network namespace, and from
# the VM runner, which has neither docker nor the repo. Net effect: the disaster
# -recovery round-trip, including the A1 read-only freeze invariant, ran NOWHERE.
# For a DR feature that is the worst possible place to have a permanent skip.
#
# The node has everything required and the harness does not: the full repo at
# /opt/insula (87 migrations), the `insula` binary, kubectl, and — verified —
# direct TCP reachability to the CNPG ClusterIP.
G_SSH=(ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no -o ConnectTimeout=20 -q)
g_node() { "${G_SSH[@]}" "$SSH_HOST" "$@"; }
# psql runs INSIDE the CNPG pod (the node has no psql client). -U postgres is
# peer-trusted there, which is also how the throwaway database gets created.
# Resolve the CNPG PRIMARY rather than assuming system-db-1. With the default
# instances:1 they are the same pod, but after an HA scale-up (or a failover)
# system-db-1 can be a read-only replica — CREATE DATABASE then fails with
# "cannot execute CREATE DATABASE in a read-only transaction", which would look
# like a DR defect rather than a harness assumption. Both label schemes are
# checked: cnpg.io/instanceRole is current, role= is the legacy one.
g_primary() {
  local p
  for sel in 'cnpg.io/cluster=system-db,cnpg.io/instanceRole=primary' 'cnpg.io/cluster=system-db,role=primary'; do
    p=$(g_node "kubectl -n platform get pods -l '$sel' -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null | tr -d '[:space:]')
    [[ -n "$p" ]] && { printf '%s' "$p"; return 0; }
  done
  printf 'system-db-1'   # last resort: the single-instance name
}
g_psql() { g_node "kubectl -n platform exec -i ${G_PGPOD:-system-db-1} -c postgres -- psql -U postgres -v ON_ERROR_STOP=1 $*"; }
# Row count in the THROWAWAY database. Every Phase G assertion below is made
# against real database state rather than against what the CLI says it did.
g_count() { g_psql "-d '$G_DB' -tAc 'SELECT COUNT(*) FROM $1'" 2>/dev/null | tr -d '[:space:]'; }

if [[ "${SKIP_RESTORE:-0}" == "1" ]]; then
  echo "  (skip G: SKIP_RESTORE=1)"
elif [[ -z "${SSH_HOST:-}" ]]; then
  echo "  (skip G: SSH_HOST unset — the round-trip runs on the cluster node)"
elif [[ -z "${OPS_BIN_G:=$(for c in /usr/local/bin/insula /usr/local/bin/platform-ops; do
        "${G_SSH[@]}" "$SSH_HOST" "test -x $c" 2>/dev/null && { echo "$c"; break; }; done)}" ]]; then
  echo "  (skip G: no insula/platform-ops binary on ${SSH_HOST#*@})"
else
  # Unique, obviously-disposable name. Asserted below so a bug in this block can
  # never point the restore at the live `platform` database.
  G_PGPOD=$(g_primary)
  echo "  CNPG primary: $G_PGPOD"
  G_DB="dr_verify_$(date +%s)_$$"
  case "$G_DB" in platform|postgres|template*) echo "  (skip G: refusing unsafe db name $G_DB)"; G_DB=""; esac
fi

if [[ -n "${G_DB:-}" ]]; then
  g_cleanup_db() {
    g_psql "-d postgres -c 'DROP DATABASE IF EXISTS \"$G_DB\" WITH (FORCE)'" >/dev/null 2>&1 || true
    g_node "rm -f /tmp/$G_DB.age" >/dev/null 2>&1 || true
  }
  trap 'g_cleanup_db; cleanup' EXIT

  echo "  throwaway database: $G_DB (dropped on exit)"
  if ! g_psql "-d postgres -c 'CREATE DATABASE \"$G_DB\"'" >"$WORK_DIR/g_create.out" 2>&1; then
    fail "G0 could not create the throwaway database: $(tail -2 "$WORK_DIR/g_create.out" | tr '\n' ' ')"
  else
    # Apply the schema exactly as platform-api's startup migrator does: every
    # *.sql in alphabetical order, stopping at the first failure. Streamed into
    # the pod so the node needs no psql client.
    # Schema for the throwaway DB comes from the LIVE platform database, not
    # from a repo checkout. `--remote` bootstrap ships scripts/ only, so
    # /opt/insula does not exist on a VM-integration node — requiring it moved
    # the permanent skip rather than removing it. pg_dump needs nothing but the
    # CNPG pod, so this phase now runs on every cluster, and it reproduces the
    # schema the platform ACTUALLY runs rather than a replay of migrations.
    # Both ends run inside the pod: no schema crosses the network.
    G_SCHEMA_FAIL=0
    G_SCHEMA_ERR=$(g_node "kubectl -n platform exec -i $G_PGPOD -c postgres -- \
        sh -c \"pg_dump -U postgres --schema-only --no-owner --no-privileges platform \
                 | psql -U postgres -v ON_ERROR_STOP=1 -q -d '$G_DB'\"" 2>&1) || G_SCHEMA_FAIL=1
    if [[ $G_SCHEMA_FAIL -ne 0 ]]; then
      fail "G0 could not clone the live schema into $G_DB: $(printf '%s' "$G_SCHEMA_ERR" | tail -3 | tr '\n' ' ')"
    else
      # Prove the clone actually produced the tables the restore writes to —
      # `psql -q` is silent on an empty input, so a no-op would look identical.
      G_TBLS=$(g_psql "-d '$G_DB' -tAc \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('backup_configurations','backup_target_assignments')\"" 2>/dev/null | tr -d '[:space:]')
      if [[ "$G_TBLS" != "2" ]]; then
        fail "G0 cloned schema is missing the DR tables (found $G_TBLS/2)"
      else
      ok "G0 live schema cloned into $G_DB (real schema, real Postgres)"

      # Credentials: derive from the URL the PLATFORM itself uses
      # (platform-db-credentials/url), NOT CNPG's default `system-db-app`
      # secret. That secret describes an `app` role and `app` database this
      # platform does not use — the login role is `platform` — so it produced
      # "password authentication failed for user app" against a healthy cluster.
      #
      # Exactly two substitutions: the DATABASE becomes the throwaway, and the
      # HOST becomes the service ClusterIP (the node has no cluster DNS for
      # `system-db-rw.platform`). User, password and port carry over verbatim,
      # so this cannot drift from the platform's real configuration.
      G_LIVE_URL=$(g_node "kubectl -n platform get secret platform-db-credentials -o jsonpath='{.data.url}' | base64 -d")
      G_IP=$(g_node "kubectl -n platform get svc system-db-rw -o jsonpath='{.spec.clusterIP}'")
      G_URL=$(G_LIVE_URL="$G_LIVE_URL" G_IP="$G_IP" G_DB="$G_DB" python3 -c '
import os, urllib.parse as u
p = u.urlparse(os.environ["G_LIVE_URL"])
creds, _, _ = os.environ["G_LIVE_URL"].partition("//")[2].rpartition("@")
host = os.environ["G_IP"] + ":" + str(p.port or 5432)
print(u.urlunparse(p._replace(netloc=(creds + "@" + host) if creds else host,
                              path="/" + os.environ["G_DB"])))')
      # Guard: the restore must NEVER be pointed at the live database.
      case "$G_URL" in
        *"/$G_DB") : ;;
        *) fail "G0 refusing to run — derived DATABASE_URL does not target $G_DB"; G_DB="" ;;
      esac
      G_ROLE=$(printf '%s' "$G_LIVE_URL" | sed -E 's#^[a-z]+://([^:@]+).*#\1#')
      g_psql "-d '$G_DB' -c 'GRANT ALL ON SCHEMA public TO \"$G_ROLE\"'" >/dev/null 2>&1 || true
      g_psql "-d postgres -c 'GRANT ALL PRIVILEGES ON DATABASE \"$G_DB\" TO \"$G_ROLE\"'" >/dev/null 2>&1 || true
      g_psql "-d '$G_DB' -c 'GRANT ALL ON ALL TABLES IN SCHEMA public TO \"$G_ROLE\"'" >/dev/null 2>&1 || true

      # The bundle was captured from THIS cluster, so the node's own operator key
      # decrypts it — no private key is copied from the harness to the node.
      G_NODE_KEY=/var/lib/insula/operator-key/operator-private.key
      scp -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no -q \
          "$WORK_DIR/bundle.age" "$SSH_HOST:/tmp/$G_DB.age" 2>/dev/null || true

      g_restore() {  # $1 = stdout file
        g_node "DATABASE_URL='$G_URL' \
                JWT_SECRET='dr-verify-not-a-real-secret-0123456789' \
                $OPS_BIN_G dr restore --bundle /tmp/$G_DB.age --age-key $G_NODE_KEY --mode partial --json" \
          > "$1" 2>"$1.err"
      }

      G_IMPORTED=0
      if g_restore "$WORK_DIR/restore.stdout"; then
        ok "G1 insula dr restore --mode partial exited 0"
        G_IMPORTED=1
      else
        fail "G1 insula dr restore failed: $(tail -2 "$WORK_DIR/restore.stdout.err" | tr '\n' ' ')"
      fi

      # Counts straight from the bundle we just produced. Every assertion below
      # compares DATABASE STATE to the BUNDLE, never to a hardcoded number, so
      # this phase stays valid on any cluster.
      B_CFGS=$(jq -r '.backupConfigurations | length' "$WORK_DIR/contents/dr-rows.json")
      B_ASSIGNS=$(jq -r '.backupTargetAssignments | length' "$WORK_DIR/contents/dr-rows.json")

      # `--json` emits {ok, bundleInfo, summary, driftNotes} (dr-ops.ts
      # success()) — the import counts live in the summary PROSE, not in a
      # machine-readable field. An earlier revision of this phase read
      # `.importResult.configsInserted`, which does not exist: jq's `// 0`
      # rendered the missing field as "configsInserted=0" and G2 PASSED while
      # asserting nothing at all. G3/G4/G5 now carry the weight by querying the
      # database directly.
      if jq -e '.ok == true and (.summary | length) > 0' "$WORK_DIR/restore.stdout" >/dev/null 2>&1; then
        ok "G2 restore reports ok=true — $(jq -r '.summary[0]' "$WORK_DIR/restore.stdout")"
      else
        fail "G2 restore JSON is not ok=true with a summary: $(head -c 200 "$WORK_DIR/restore.stdout")"
      fi

      # A1 FREEZE INVARIANT — the reason this phase must not be skipped. An
      # imported backup config must never be writable: a restored cluster that
      # can write to the ORIGINAL cluster's backup targets would corrupt the
      # very backups it was restored from.
      # Gate on G1. "0 rows violate the invariant" is trivially true of an EMPTY
      # table, so without this gate G3 reports success precisely when the
      # restore FAILED — a false green exactly where DR most needs a real one.
      # Observed on the first node-side run: G1 failed on credentials and G3/G4
      # still printed PASS with total=0.
      if [[ "$G_IMPORTED" != "1" ]]; then
        fail "G3/G4/G5 not evaluated — the import failed, so an empty table proves nothing"
      else
        G_CFGS=$(g_count backup_configurations)
        G_NON_RO=$(g_psql "-d '$G_DB' -tAc 'SELECT COUNT(*) FROM backup_configurations WHERE read_only IS NOT TRUE'" 2>/dev/null | tr -d '[:space:]')
        if [[ "$G_NON_RO" != "0" ]]; then
          fail "G3 $G_NON_RO of $G_CFGS restored config(s) have read_only != true — A1 freeze invariant violated"
        elif [[ "$G_CFGS" != "$B_CFGS" ]]; then
          fail "G3 restored $G_CFGS backup_configurations but the bundle carries $B_CFGS"
        else
          ok "G3 all $G_CFGS bundle backup_configurations restored, every one read_only=true"
        fi

        G_ASSIGNS=$(g_count backup_target_assignments)
        if [[ "$G_ASSIGNS" == "$B_ASSIGNS" && "${G_ASSIGNS:-0}" -gt 0 ]]; then
          ok "G4 restored all $G_ASSIGNS backup_target_assignments carried by the bundle"
        else
          fail "G4 restored $G_ASSIGNS backup_target_assignments, bundle carries $B_ASSIGNS"
        fi

        # Idempotency: an operator re-running a restore after an interruption
        # must not duplicate rows. Asserted on DATABASE STATE, not on the tool's
        # own report — the end state is what the operator has to live with, and
        # it does not depend on the CLI's output shape.
        if g_restore "$WORK_DIR/restore2.stdout"; then
          G_CFGS2=$(g_count backup_configurations)
          G_ASSIGNS2=$(g_count backup_target_assignments)
          # Unchanged counts alone cannot tell "correctly skipped the existing
          # rows" apart from "did nothing at all" — both leave the table as it
          # was. The summary reports "Imported N ... (M already present) ...",
          # so assert the importer actually SAW and skipped every row.
          G_SUM2=$(jq -r '.summary[0] // ""' "$WORK_DIR/restore2.stdout")
          G_SKIPPED=$(printf '%s' "$G_SUM2" | sed -nE 's/.*\(([0-9]+) already present\).*/\1/p')
          if [[ "$G_CFGS2" != "$G_CFGS" || "$G_ASSIGNS2" != "$G_ASSIGNS" ]]; then
            fail "G5 re-run changed row counts: configs $G_CFGS->$G_CFGS2, assignments $G_ASSIGNS->$G_ASSIGNS2"
          elif [[ "$G_SKIPPED" != "$B_CFGS" ]]; then
            fail "G5 re-run reported '$G_SUM2' — expected it to skip $B_CFGS existing config(s)"
          else
            ok "G5 re-run is idempotent ($G_CFGS2 configs / $G_ASSIGNS2 assignments unchanged; $G_SKIPPED skipped as already present)"
          fi
        else
          fail "G5 re-run failed: $(tail -2 "$WORK_DIR/restore2.stdout.err" | tr '\n' ' ')"
        fi
      fi   # end G1-gated assertions
      fi  # end G0 table check
    fi
  fi
fi

# Phase H exercises the OPERATOR-FACING CLI, `insula dr restore` — not the
# scripts/dr-restore-bundle.sh wrapper it replaced.
#
# ADR-055 folded the operator CLI into a single signed binary at
# /usr/local/bin/insula, and dr.ts states its argv surface "mirrors that shim so
# operators carry no new muscle memory". The shim needs the full repo (it execs
# the TS runner through tsx) and therefore cannot run on a real node at all —
# the VM integration runner receives scripts/ only, which is why every H
# assertion failed there on 2026-08-10. Testing the shim also tested the wrong
# thing: during an incident an operator runs the binary, and the binary is what
# ships.
#
# Exit-code contract (dr.ts header, confirmed empirically against a live node):
#   0 = success · 1 = runtime failure · 2 = usage error
OPS_BIN="${PLATFORM_OPS_BIN:-}"
if [[ -z "$OPS_BIN" && -n "${SSH_HOST:-}" ]]; then
  for _c in /usr/local/bin/insula /usr/local/bin/platform-ops; do
    if ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no \
         -o ConnectTimeout=15 -q "$SSH_HOST" "test -x $_c" 2>/dev/null; then
      OPS_BIN="$_c"; break
    fi
  done
fi
if [[ -z "${SSH_HOST:-}" || -z "$OPS_BIN" ]]; then
  echo "  (skip H: no operator CLI reachable — set SSH_HOST (and PLATFORM_OPS_BIN if it is not at /usr/local/bin/insula))"
else
echo "  using $OPS_BIN on ${SSH_HOST#*@}"

# Run a dr subcommand on the node; echo "<rc>|<stdout+stderr first line>".
# Every invocation below is DELIBERATELY invalid so it cannot reach a restore.
h_run() {
  local out rc
  out=$(ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no \
        -o ConnectTimeout=20 -q "$SSH_HOST" "$OPS_BIN $* 2>&1"; printf '|RC=%s' "$?")
  rc="${out##*|RC=}"
  printf '%s|%s' "$rc" "$(printf '%s' "${out%|RC=*}" | head -1)"
}

# H1: --mode full without --target-mail-node → usage error naming the flag.
_h=$(h_run dr restore --bundle /dev/null --age-key /dev/null --mode full)
if [[ "${_h%%|*}" == "2" && "${_h#*|}" == *target-mail-node* ]]; then
  ok "H1 mode=full without --target-mail-node exits 2 with clear error"
else
  fail "H1 expected exit 2 + target-mail-node mention; got: $_h"
fi

# H2: --mode full with a mail node but no typed cluster confirmation.
_h=$(h_run dr restore --bundle /dev/null --age-key /dev/null --mode full --target-mail-node n1)
if [[ "${_h%%|*}" == "2" && "${_h#*|}" == *confirm-cluster* ]]; then
  ok "H2 mode=full without --confirm-cluster exits 2 with clear error"
else
  fail "H2 expected exit 2 + confirm-cluster mention; got: $_h"
fi

# H3: an unknown --mode value is a usage error, not a silent default.
_h=$(h_run dr restore --bundle /dev/null --age-key /dev/null --mode bogus)
if [[ "${_h%%|*}" == "2" ]]; then
  ok "H3 unknown --mode value exits 2"
else
  fail "H3 expected exit 2; got: $_h"
fi

# H4: --help works and documents both modes. This is the command an operator
# reaches for mid-incident; it answered "unknown argument '--help'" (exit 2)
# until 2026-08-11.
_h=$(h_run dr restore --help)
if [[ "${_h%%|*}" == "0" ]]; then
  _htext=$(ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no \
           -o ConnectTimeout=20 -q "$SSH_HOST" "$OPS_BIN dr restore --help 2>&1" || true)
  if grep -q 'partial' <<<"$_htext" && grep -q 'full' <<<"$_htext"; then
    ok "H4 --help exits 0 and documents both partial and full modes"
  else
    fail "H4 --help exited 0 but does not document both modes"
  fi
else
  fail "H4 --help should exit 0; got: $_h"
fi

fi   # end Phase H operator-CLI guard

echo
echo "─── Summary ───"
echo "  passed: $PASS"
echo "  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
echo "✅ integration-dr-bundle: all checks passed."
