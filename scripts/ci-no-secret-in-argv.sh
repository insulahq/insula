#!/usr/bin/env bash
# ci-no-secret-in-argv.sh — guard against plaintext secrets inlined into
# command argv built by the platform-api process.
#
# WHY: anything that reaches a container's argv is visible via
# `kubectl describe pod`, the apiserver audit log, and `ps`. S3 / blob /
# rclone credentials MUST flow via a Secret-mounted env var that the
# in-Pod shell expands at run time (`accessKey=$S3_ACCESS_KEY`), NEVER as
# a literal read out of JS process memory.
#
# HISTORY (2026-07-28): this guard used to target one file,
# backend/src/modules/mail-admin/blob-store.ts, which was FULLY RETIRED in
# #205 (895e1226, ADR-046 follow-up). With its target gone the guard threw
# "target file not found" and exited 1 — a guard that can only fail is
# worse than none, and it had been wired into no workflow so nobody saw it.
# Rewritten to scan the whole backend for the dangerous SHAPE instead of a
# single now-deleted file, so it keeps protecting the invariant wherever a
# credential-bearing argv might reappear (stalwart-cli, rclone, restic, …).
#
# Run from repo root:  ./scripts/ci-no-secret-in-argv.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/backend/src"

CRED_KEYS='accessKey|secretKey|access_key|secret_key|access-key|secret-key'

# We POSITIVELY match the two dangerous shapes rather than "everything that
# isn't a shell var" — a JS template `${expr}` starts with `$` exactly like a
# shell `$VAR`, so an exclude-the-safe approach mis-passes `${provider.key}`.
#
# SAFE (never flagged):
#   accessKey=$S3_ACCESS_KEY        bare shell var  → in-pod shell expands it
#   accessKey=${S3_ACCESS_KEY}      braced shell var (name only, no '.'/'(')
#
# DANGER 1 — JS interpolation: a `${...}` whose braces contain a '.' or '('
#   (property access / call). A POSIX shell var name is [A-Za-z_][A-Za-z0-9_]*,
#   so a '.' or '(' inside the braces can only be JS reading process memory.
#     accessKey=${provider.plaintextKey}   secretKey=${creds.get()}
DANGER_JS_INTERP="(${CRED_KEYS})=[\"'\`]?\\\$\\{[^}]*[.(][^}]*\\}"
#
# DANGER 2 — hardcoded literal: RHS begins with an alphanumeric (not '$'),
#   i.e. a key baked into the source.
#     accessKey=AKIA...   secretKey=abc123
DANGER_LITERAL="(${CRED_KEYS})=[\"'\`]?[A-Za-z0-9]"

violations=$(
  grep -rnE "(${DANGER_JS_INTERP})|(${DANGER_LITERAL})" "$SRC" --include='*.ts' 2>/dev/null \
    | grep -vE '\.test\.ts:' \
    | grep -vE "://" \
    | grep -vE ":[[:space:]]*(//|\*)" \
    || true
)

if [ -n "$violations" ]; then
  echo "ci-no-secret-in-argv: FAIL — possible plaintext secret assigned to a cli arg:" >&2
  echo "$violations" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  Credentials MUST flow via a Secret-mounted env var expanded by the" >&2
  echo "  in-Pod shell (accessKey=\$S3_ACCESS_KEY), never a JS-interpolated literal." >&2
  echo "  If this is a false positive (a comment, a schema key, a non-argv use)," >&2
  echo "  adjust the allowlist in scripts/ci-no-secret-in-argv.sh." >&2
  exit 1
fi

echo "ci-no-secret-in-argv: ok — no plaintext credential in any backend cli argv"
