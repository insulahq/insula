#!/usr/bin/env bash
#
# CI guard — nothing in the notification domain may grow without a ceiling.
#
# Why this guard exists
# ---------------------
# `notification_template_versions` archived a full template body on every
# operator edit and had NO retention of any kind — monotonic growth driven
# purely by how often somebody tuned wording. Before that, the `notifications`
# inbox table had none either: measured on staging 2026-09-10, 2685 rows going
# back to the first migration, 2619 of them older than 30 days, never reaped.
#
# Both were "obviously fine" at review time. The failure mode is always the
# same — a new table lands, its purge is left for later, and nothing fails.
#
# What is checked
# ---------------
#   1. Every *_RETENTION_DAYS constant is > 0 and <= MAX_RETENTION_DAYS (90).
#      A zero disables the purge; a larger window breaks the operator's cap.
#   2. Every table listed in TABLES below is actually deleted from by purge.ts.
#   3. The retention result type names every table, so a table whose pruning
#      is invisible in the logs cannot exist.
#   4. The pass is actually scheduled (run at startup, not only on an interval
#      that a frequently-rolled deployment never reaches).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PURGE="$REPO_ROOT/backend/src/modules/notifications/retention/purge.ts"
SCHED="$REPO_ROOT/backend/src/modules/notifications/retention/scheduler.ts"

MAX_DAYS=90

# Every table the notification domain writes to unboundedly. Adding a table
# here without a purge fails the build — which is the point.
TABLES="notifications notification_deliveries notification_rate_limit_buckets notification_template_versions notification_object_mutes"

# Bounded elsewhere, on purpose — each is pruned by the pass that writes it,
# where the dedupe semantics live. Listed here so "every notification-domain
# table is bounded" stays a checkable claim rather than a belief.
EXTERNALLY_BOUNDED="
mailbox_quota_events|backend/src/modules/mail-stats/quota-notifications.ts|30 days
email_quota_events|backend/src/modules/mail-events/thresholds.ts|QUOTA_EVENT_RETENTION_DAYS
"

fail=0
err() { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

# snake_case table name -> the camelCase identifier drizzle uses for it.
to_camel() {
  echo "$1" | awk -F_ '{printf "%s", $1; for (i=2;i<=NF;i++) printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}'
}

echo "── notification retention guard ─────────────────────────────────────"

for f in "$PURGE" "$SCHED"; do
  [ -f "$f" ] || { err "missing $f"; exit 1; }
done

# ── 1. Windows are real and within the ceiling ─────────────────────────
declared=$(grep -cE '^export const [A-Z_]*RETENTION_DAYS' "$PURGE" || true)
if [ "$declared" -eq 0 ]; then
  err "no *_RETENTION_DAYS constants found in purge.ts — the parse broke."
  echo "     Fix the check; do NOT let it pass over an empty set." >&2
  exit 1
fi

while read -r name value; do
  [ -n "$name" ] || continue
  if [ "$value" -le 0 ]; then
    err "$name = $value disables its purge entirely."
  elif [ "$value" -gt "$MAX_DAYS" ]; then
    err "$name = $value exceeds the ${MAX_DAYS}-day ceiling."
  else
    printf '    %-34s %s days\n' "$name" "$value"
  fi
done < <(grep -E '^export const [A-Z_]*RETENTION_DAYS' "$PURGE" \
  | sed -E 's/^export const ([A-Z_]+) *= *([0-9]+).*/\1 \2/')

if ! grep -qE '^export const MAX_RETENTION_DAYS *= *'"$MAX_DAYS"'\b' "$PURGE"; then
  err "MAX_RETENTION_DAYS is not $MAX_DAYS in purge.ts — the ceiling moved."
fi

# ── 2. Every table is actually purged ──────────────────────────────────
# Match the Drizzle table identifier OR the raw SQL name, since the pass uses
# both styles (a window function needs raw SQL).
for t in $TABLES; do
  camel=$(echo "$t" | awk -F_ '{printf "%s", $1; for(i=2;i<=NF;i++) printf "%s%s", toupper(substr($i,1,1)), substr($i,2)}')
  if grep -q "$t" "$PURGE" || grep -q "$camel" "$PURGE"; then
    printf '    %-34s purged\n' "$t"
  else
    err "$t has no purge in purge.ts — it grows without a ceiling."
  fi
done

# ── 3. Every purged table is reported ──────────────────────────────────
# A table missing from the result shape is a table whose growth is invisible
# in the logs, which is exactly how template_versions went unnoticed.
for field in deliveries notifications buckets templateVersions expiredMutes; do
  grep -q "readonly $field:" "$PURGE" \
    || err "NotificationRetentionResult has no '$field' — its pruning is unreported."
  grep -q "$field" "$SCHED" \
    || err "the scheduler log line omits '$field'."
done

# ── 4. The pass actually runs ──────────────────────────────────────────
# A bare setInterval is not enough: a deployment that rolls more often than
# the interval never reaches the tick. Measured on DEV — eleven ReplicaSets in
# 20 hours, longest gap 9h28m, so a 24h interval never fired there at all.
grep -q "safeTick" "$SCHED" || err "scheduler no longer uses safeTick."
if ! grep -qE 'safeTick\([^)]*\)[^;]*;\s*$|runOnce\(db\)' "$SCHED"; then
  err "scheduler does not appear to run once at startup."
fi

# ── 5. Tables bounded outside purge.ts still have a bound ──────────────
while IFS='|' read -r tbl file marker; do
  [ -n "$tbl" ] || continue
  full="$REPO_ROOT/$file"
  if [ ! -f "$full" ]; then
    err "$tbl claims to be bounded by $file, which does not exist."
  # Two spellings, both legitimate: raw `DELETE FROM <table>` and drizzle's
  # `db.delete(<camelCaseTable>)`. Matching only the first reported a missing
  # purge for email_quota_events, which has had one all along — an audit whose
  # selector cannot match its subject reads exactly like a real finding.
  elif { grep -q "DELETE FROM $tbl" "$full" || grep -q "delete($(to_camel "$tbl"))" "$full"; } \
       && grep -q "$marker" "$full"; then
    printf '    %-34s purged by %s\n' "$tbl" "$(basename "$file")"
  else
    err "$tbl has no purge in $file — it grows without a ceiling."
  fi
done <<< "$EXTERNALLY_BOUNDED"

[ "$fail" -eq 0 ] || exit 1
echo "ci-notification-retention: OK — every table bounded, ceiling ${MAX_DAYS}d, pass runs at startup."
