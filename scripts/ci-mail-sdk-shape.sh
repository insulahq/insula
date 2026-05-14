#!/usr/bin/env bash
# ci-mail-sdk-shape.sh — fail CI when a call site in backend/src/modules/mail-admin/
# uses the SDK v0-style positional-args calling convention for any
# @kubernetes/client-node API method.
#
# Background. @kubernetes/client-node went through a v0 → v1 rewrite. v0
# took positional args:
#   await core.readNode(name)
#   await apps.readNamespacedDeployment(name, namespace)
# v1 takes object args:
#   await core.readNode({ name })
#   await apps.readNamespacedDeployment({ name, namespace })
#
# v0 calls SILENTLY pass on the v1 SDK — the first arg is interpreted
# as the args object, fails internally with something like
# "name.startsWith is not a function", and the typical .catch()
# translates it to a misleading high-level error.
#
# Real bug shapes this script catches:
#   migration.ts:84 "Node 'staging1' not found" while node was healthy
#     (v0 readNode(string) → v1 SDK threw, .catch translated)
#   dr-watcher.ts:isNodeReady false-negatives for the same reason
#   migration.ts:waitForReplicaCount silently timing out
#
# Rule. Every call to a known @kubernetes/client-node API method MUST
# be either:
#   (a) Direct: `await client.method({ ... })` with object args, OR
#   (b) Cast: `await (client as ...).method({ ... }, override)` with
#       object args.
# Anywhere a positional-style cast `... as { method: (name: string, ns: string) => ...`
# appears, fail.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# v1 SDK methods we care about. Two forms:
#   (a) Inside a cast — `{ readNode: (name: string, ...`
#   (b) At a call site — `.readNode(name, ...)`
# This script targets form (a) — that's the explicit "I'm forcing the
# v0 signature" marker. Form (b) is much harder to lint statically
# because it doesn't distinguish positional-string-arg from
# object-arg without parsing the AST. We accept the (b) false-negative
# risk because if a developer cast to the v0 signature, they meant it.
METHOD_NAMES_RE='(read|patch|delete|create|list|replace)(Namespaced[A-Za-z]+|Node)'

mapfile -t HITS < <(
  grep -rnE "as unknown as \{[[:space:]]*${METHOD_NAMES_RE}: \(" \
    backend/src/modules/mail-admin \
    --include='*.ts' --exclude='*.test.ts' \
    2>/dev/null \
    | sort -u
)

# Match the explicit v0 shape: `as { method: (name: string` — that's
# the smoking-gun pattern. v1 casts look like
# `as Parameters<typeof obj.method>[0]` — those don't match.

FAIL=0
for hit in "${HITS[@]}"; do
  # Skip lines that are the v1 Parameters<typeof ...> form even after match.
  if echo "$hit" | grep -qE 'Parameters<typeof'; then
    continue
  fi
  FAIL=1
  echo "  $hit"
done

if [ "$FAIL" -eq 1 ]; then
  echo
  echo "❌ ci-mail-sdk-shape: v0-positional @kubernetes/client-node call(s) in mail-admin/"
  echo
  echo "  Switch to v1 object-args:"
  echo "    BEFORE:  await (core as unknown as { readNode: (name: string) => ... }).readNode(name)"
  echo "    AFTER:   await core.readNode({ name })"
  echo
  echo "  See ~/.claude/projects/-workspace-k8s-hosting-platform/memory/project_mail_architecture_streamline_2026_05_14.md"
  exit 1
fi

echo "✅ ci-mail-sdk-shape: all mail-admin K8s API calls use v1 object-args."
