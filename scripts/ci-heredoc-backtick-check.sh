#!/usr/bin/env bash
# ci-heredoc-backtick-check.sh — reject UNESCAPED backticks inside an UNQUOTED
# heredoc.
#
# Background. An unquoted heredoc delimiter (`<<NFT`) expands both `${var}` and
# BACKTICKS. A `#` inside such a heredoc is ordinary text — it is not a shell
# comment — so prose that happens to quote an identifier in backticks becomes
# command substitution and RUNS.
#
# This shipped on 2026-08-11 and broke every fresh install. Two comment lines
# inside `cat > /etc/nftables.conf <<NFT`:
#
#     # Pod CIDR → the node's own DNS resolver. CoreDNS runs `dnsPolicy: Default`
#     # dots than `ndots` tries `<name>.<mesh-domain>` FIRST, that query
#
# produced, on the node:
#
#     /tmp/bootstrap.sh: line 2358: dnsPolicy:: command not found
#     /tmp/bootstrap.sh: line 2358: ndots: command not found
#     command substitution: line 2359: syntax error near unexpected token `newline'
#     remote bootstrap exited rc=2
#
# Note the reported line is where the HEREDOC OPENS, not where the backtick is —
# which is why this reads as a corrupt file rather than a content bug, and why
# it cost two full VM runs to localise.
#
# `bash -n` does NOT catch it: a command substitution is valid syntax. The
# failure is at runtime. Worse, when it does not abort it silently DELETES the
# backticked span from the generated file, so the emitted config is wrong in a
# way nothing downstream reports.
#
# The fix is to quote the identifier some other way ('dnsPolicy') or escape the
# backtick (\`). The codebase already does the latter elsewhere — see the
# POD_YAML heredoc — so this guard enforces an existing convention.
#
# Exit 0 = clean, 1 = at least one offender.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Default to the scripts that are shipped to a node and executed there, where
# this failure is both most likely and most expensive.
FILES=("${@:-}")
if [[ -z "${FILES[0]:-}" ]]; then
  mapfile -t FILES < <(find "$ROOT/scripts" -maxdepth 2 -name '*.sh' -type f | sort)
fi

python3 - "${FILES[@]}" <<'PY'
import re, sys

open_re = re.compile(r"""<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1""")

def has_unescaped_backtick(line: str) -> bool:
    k = 0
    while k < len(line):
        if line[k] == '\\':
            k += 2          # \` is a literal backtick — the safe, intended form
            continue
        if line[k] == '`':
            return True
        k += 1
    return False

def opener(line):
    """Return the unquoted heredoc delimiter on this line, or None.

    Two things make a naive regex wrong here, both hit on the first run:
      * `<<NFT` inside a STRING (e.g. [[ "$l" == *"... <<NFT" ]]) is not a
        heredoc — ci-firewall-check.sh greps for that literal text.
      * A heredoc whose terminator never appears means we mis-parsed; running
        to EOF would flag the whole rest of the file.
    """
    for m in open_re.finditer(line):
        if m.group(1):
            continue                     # <<'EOF' / <<"EOF" do not expand
        before = line[:m.start()]
        # inside an odd number of quotes -> it is string content, not an opener
        if before.count('"') % 2 or before.count("'") % 2:
            continue
        return m.group(2)
    return None

bad = []
for path in sys.argv[1:]:
    try:
        src = open(path, encoding='utf-8', errors='replace').read().splitlines()
    except OSError:
        continue
    i = 0
    while i < len(src):
        delim = None if src[i].lstrip().startswith('#') else opener(src[i])
        if delim:
            start = i
            end = None
            for j in range(i + 1, len(src)):
                if src[j].strip() == delim:
                    end = j
                    break
            if end is None:            # unterminated -> we mis-parsed; do not guess
                i += 1
                continue
            for j in range(start + 1, end):
                if has_unescaped_backtick(src[j]):
                    bad.append((path, start + 1, delim, j + 1, src[j].strip()[:100]))
            i = end
        i += 1

if bad:
    print("FAIL: unescaped backtick inside an unquoted heredoc "
          "(it becomes command substitution and RUNS):\n")
    for path, opened, delim, ln, txt in bad:
        print(f"  {path}:{ln}  (inside <<{delim} opened at line {opened})")
        print(f"      {txt}")
    print("\nFix: quote it differently ('name') or escape the backtick (\\`).")
    sys.exit(1)

print(f"OK: no unescaped backticks inside unquoted heredocs ({len(sys.argv) - 1} file(s) scanned)")
PY
