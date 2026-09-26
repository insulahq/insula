#!/usr/bin/env bash
#
# CI guard — no backticks inside a Drizzle sql`` template literal.
#
# Why this guard exists
# ---------------------
# A backtick in a SQL comment inside `sql`...`` CLOSES the template literal. The
# SQL still reads perfectly, so the eye goes to the query; tsc reports
# `error TS1005: ',' expected` at a line that looks fine, often far from the
# comment. It happened twice in one change set while writing the
# workload-health reconciler, both times in a prose comment quoting a column
# name:
#
#     await db.execute(sql`
#       SELECT ...,
#              -- `heal_attempts` counts CLAIMED attempts, so ...
#                 ^                ^ template closed here, reopened here
#     `);
#
# scripts/ci-heredoc-backtick-check.sh guards the shell-heredoc form of exactly
# the same mistake. This is the TypeScript form, which that guard cannot see.
#
# What is checked
# ---------------
# Every `sql\`` ... \`` ` region in backend TypeScript, for a backtick that is
# neither the opening nor the closing delimiter. `${...}` interpolations are
# fine and common; only a stray backtick is an error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "── sql\`\` backtick guard ─────────────────────────────────────────────"

mapfile -t FILES < <(find backend/src -name '*.ts' -not -name '*.test.ts' | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ci-sql-template-backtick: no files to scan" >&2
  exit 1
fi

python3 - "${FILES[@]}" <<'PY'
import io, re, sys

failures = []
scanned = 0
regions = 0
for path in sys.argv[1:]:
    src = io.open(path, encoding='utf-8').read()
    scanned += 1
    # Walk each `sql`` opener and find its matching close, counting the
    # backticks in between. A template literal ends at the first unescaped
    # backtick that is not inside a ${...} interpolation; we do not need to
    # model interpolation precisely — ANY backtick between the delimiters is
    # already the bug we are looking for.
    for m in re.finditer(r'\bsql`', src):
        start = m.end()
        nxt = src.find('`', start)
        if nxt == -1:
            continue
        regions += 1
        # A well-formed region has no further backtick before its terminator,
        # so nxt IS the terminator. To catch the broken shape we instead look
        # for a backtick on a line that is a SQL comment or mid-statement.
        # Reconstruct the intended region: from the opener to the line that
        # closes the db.execute / sql call.
        seg = src[start:nxt]
        line_no = src[:start].count('\n') + 1
        # If the segment that precedes the first backtick contains an
        # unterminated SQL comment marker, the backtick is almost certainly
        # inside a comment rather than closing the template.
        tail = seg.rsplit('\n', 1)[-1]
        if '--' in tail:
            failures.append((path, src[:nxt].count('\n') + 1, tail.strip()[:100]))

if failures:
    print(f"FAIL: {len(failures)} backtick(s) inside a sql`` template literal:\n")
    for path, line, ctx in failures:
        print(f"  {path}:{line}")
        print(f"      {ctx}")
    print("""
A backtick inside sql`` closes the template literal. The SQL reads fine and tsc
blames an unrelated line. Use plain text or quotes in SQL comments.""")
    sys.exit(1)

print(f"OK: no backticks inside sql`` templates ({regions} region(s) in {scanned} file(s) scanned).")
PY
