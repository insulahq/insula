#!/usr/bin/env bash
set -euo pipefail

# ci-heredoc-expansion-check.sh — fail CI when an UNQUOTED heredoc body
# contains a backtick, i.e. prose the shell will execute as a command.
#
# Background: `cat <<EOF` (delimiter unquoted) performs parameter expansion,
# command substitution AND backtick substitution on the body. The expansion is
# wanted for `${VAR}`; it applies just the same to explanatory text, including
# YAML `#` comments inside the body.
#
# Real bug this prevents: bootstrap.sh's Flux Kustomization heredoc carried
# seven backticked spans in its comments ("the former `op: remove
# /spec/instances` patch…", "FAILS the whole `kustomize build`"). Every install
# ran them as commands and printed to the operator's console:
#     bootstrap.sh: line 4718: op:: command not found
#     bootstrap.sh: line 4718: kustomize: command not found        (+5 more)
# The rendered YAML stayed valid — the substitutions sat inside comments, so
# only the words vanished — which is precisely why it survived releases: the
# install kept working and the noise read as upstream chatter. It was not
# harmless in principle: a backticked span naming a real command would have
# executed it, as root, mid-install.
#
# Scope note: `$( )` inside an unquoted heredoc is NOT flagged. It is the
# normal, intentional way these scripts interpolate values into generated JSON
# and YAML. Backticks are the reliable signal — this codebase writes command
# substitution as `$( )` everywhere, so a backtick in a heredoc body is prose.
#
# Rule: inside an unquoted heredoc, write inline code in 'single quotes'.
# If a body needs no expansion at all, quote the delimiter (<<'EOF') and this
# check skips it entirely.

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

python3 - "$@" <<'PYEOF'
import re, sys, pathlib

# A heredoc redirection: <<WORD or <<-WORD, delimiter optionally quoted.
# Anchored on `<<` NOT preceded by another `<` (so `a << b` shifts and `<<<`
# here-strings don't match).
START = re.compile(r'(?<![<])<<-?\s*(?P<q>[\'"]?)(?P<delim>[A-Za-z_][A-Za-z0-9_]*)(?P=q)')

bad = []
for path in sorted(pathlib.Path("scripts").rglob("*.sh")):
    delim = None
    dash = False
    opened = 0
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.rstrip("\n")
        if delim is None:
            # Comment lines can't open a heredoc — and prose like
            # "(requests << limits)" would otherwise look exactly like one.
            if line.lstrip().startswith("#"):
                continue
            m = START.search(line)
            if not m:
                continue
            if m.group("q"):        # quoted delimiter → literal body, skip
                continue
            # `[[ "$line" == *"cat > f <<NFT" ]]` is a string comparison, not a
            # redirection. An odd number of double quotes before the match means
            # we are inside a string literal.
            if line[:m.start()].count('"') % 2 == 1:
                continue
            delim, opened = m.group("delim"), n
            dash = "<<-" in line[max(0, m.start() - 1):m.end()]
            continue
        # inside an unquoted heredoc body
        term = line.lstrip("\t") if dash else line
        if term == delim:
            delim = None
            continue
        # An ESCAPED backtick (\`) is literal, not command substitution —
        # Traefik rule syntax (Host(\`example.test\`)) needs them.
        if "`" in line.replace("\\`", ""):
            bad.append((str(path), n, opened, delim, line.strip()))

for path, n, opened, delim, text in bad:
    print(f"{path}:{n}: backtick inside unquoted heredoc <<{delim} "
          f"(opened line {opened}) — the shell will EXECUTE it")
    print(f"        {text}")

if bad:
    print()
    print(f"ci-heredoc-expansion-check: FAILED — {len(bad)} line(s) above.", file=sys.stderr)
    print("Fix: use 'single quotes' for inline code in the body, or quote the", file=sys.stderr)
    print("heredoc delimiter (<<'EOF') if the body needs no expansion at all.", file=sys.stderr)
    sys.exit(1)

print("ci-heredoc-expansion-check: OK — no backticks in unquoted heredoc bodies.")
PYEOF
