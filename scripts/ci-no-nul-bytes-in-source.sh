#!/usr/bin/env bash
# scripts/ci-no-nul-bytes-in-source.sh — fail when a tracked, non-test
# source file contains a raw NUL byte.
#
# Why: grep treats a file containing NUL as BINARY and silently skips it —
# `grep -rn` prints nothing for it. Every grep-based CI guard and every code inventory is
# then blind to that file. A raw NUL in a regex literal hid
# security-hardening/cscli-exec.ts from the inventory behind the platform-api
# exec admission policy, which then refused CrowdSec's `cscli` exec in
# DEV testing. Write `\x00` or `\u0000` instead — identical at runtime.
# (Other raw control bytes, e.g. ESC in terminal colour codes, do not blind
# grep and are left alone.)
#
# Test files are exempt: some feed raw control bytes to validators on purpose.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

bad=()
while IFS= read -r -d '' f; do
  case "$f" in
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*/__tests__/*|*/testdata/*|*/fixtures/*) continue ;;
  esac
  [[ -f "$f" ]] || continue
  # -a is load-bearing: without it grep treats the very files this hunts for
  # as binary and the pattern never matches.
  if LC_ALL=C grep -q -a -P '\x00' "$f"; then bad+=("$f"); fi
done < <(git ls-files -z -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.sh' '*.go' '*.yaml' '*.yml' '*.py')

if (( ${#bad[@]} > 0 )); then
  echo "FAIL: raw NUL bytes in source (grep treats these files as binary and skips them):"
  for f in "${bad[@]}"; do
    LC_ALL=C grep -n -a -P '\x00' "$f" | cut -d: -f1 | head -3 \
      | sed "s|^|  $f:|"
  done
  printf '%s\n' 'Write the escape sequence (\x00 or \u0000) instead of the raw byte.'
  exit 1
fi
echo "OK: no raw NUL bytes in tracked non-test source files"
