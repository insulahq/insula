#!/usr/bin/env bash
# ci-no-password-fields-in-entry-chunk.sh
#
# A password input in the bytes a page EAGERLY loads makes the operator's
# password manager pop its autofill prompt on every navigation — while they are
# already signed in. Reported twice now: once for the change-password form
# inlined into Header.tsx (fixed by extracting ChangePasswordModal), and again
# because that was only half of it. The real cause was that panel routes were
# not code-split, so every page's markup — Login, AdminUsers, OidcPage,
# RemoteStorageTargetsPage, SubUsers, Email, … — compiled into the single entry
# chunk that loads on EVERY page view.
#
# WHY A BUNDLE-LEVEL GUARD AND NOT A UNIT TEST: unit tests cannot see this at
# all. The markup is never in the DOM (the forms are conditionally rendered);
# it is the SHIPPED BYTES the password manager reacts to. The only assertion
# that counts is a real `vite build` followed by grepping the chunks that
# index.html loads eagerly.
#
# What "eagerly loaded" means here: the entry <script src>, plus every
# <link rel=modulepreload href> — the browser fetches all of them on any page.
# Chunks pulled in later by React.lazy are fine, and are where these fields are
# SUPPOSED to live.
#
# Run: ./scripts/ci-no-password-fields-in-entry-chunk.sh [--skip-build] [panel…]
#
#   --skip-build   reuse an existing dist/ (CI already ran `npm run build`)
#   panel…         admin-panel | tenant-panel; default is both
#
# The per-panel argument exists because each panel's workflow is path-filtered
# and builds only itself — checking the other one would read a stale or absent
# dist/ and report a pass that means nothing.
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SKIP_BUILD=0
PANELS=()
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    admin-panel|tenant-panel) PANELS+=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
(( ${#PANELS[@]} == 0 )) && PANELS=(admin-panel tenant-panel)

FAILED=0
fail() { echo "  ✗ $1" >&2; FAILED=1; }
ok()   { echo "  ✓ $1"; }

# Tokens that only ever appear on a real password input. `type:"password"` is
# the minified JSX prop; the autocomplete tokens are what a manager keys on.
PATTERNS='current-password|new-password|type:"password"|type:`password`'

for panel in "${PANELS[@]}"; do
  dir="$REPO_ROOT/frontend/$panel"
  [[ -d "$dir" ]] || { fail "$panel: directory missing"; continue; }

  if (( SKIP_BUILD == 0 )); then
    echo "building $panel..."
    ( cd "$dir" && npm run build >/tmp/pwguard-$panel.log 2>&1 ) || {
      fail "$panel: build failed — see /tmp/pwguard-$panel.log"
      tail -20 "/tmp/pwguard-$panel.log" >&2
      continue
    }
  fi

  html="$dir/dist/index.html"
  [[ -f "$html" ]] || { fail "$panel: dist/index.html missing (build did not run?)"; continue; }

  # Every JS asset index.html references — entry script AND modulepreloads.
  mapfile -t eager < <(grep -oE '(src|href)="/assets/[^"]+\.js"' "$html" \
                        | sed 's/.*="\///; s/"$//' | sort -u)
  if (( ${#eager[@]} == 0 )); then
    fail "$panel: no eagerly-loaded JS assets found in index.html — guard cannot verify anything"
    continue
  fi

  panel_bad=0
  for asset in "${eager[@]}"; do
    f="$dir/dist/$asset"
    [[ -f "$f" ]] || continue
    hits=$(grep -oE "$PATTERNS" "$f" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$hits" != "0" ]]; then
      fail "$panel: $asset is loaded on EVERY page and contains $hits password-input marker(s)"
      grep -oE ".{40}($PATTERNS).{25}" "$f" 2>/dev/null | head -3 | sed 's/^/       /' >&2
      panel_bad=1
    fi
  done

  # A guard that finds nothing because the app has no password fields AT ALL
  # would pass forever while proving nothing. Assert they exist in some lazy
  # chunk, so this stays a statement about WHERE they are.
  lazy_hits=$(grep -lE "$PATTERNS" "$dir"/dist/assets/*.js 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$lazy_hits" == "0" ]]; then
    fail "$panel: no chunk contains a password input — the guard is not actually testing anything"
  fi

  (( panel_bad == 0 )) && ok "$panel: ${#eager[@]} eagerly-loaded chunk(s) clean; password inputs isolated in ${lazy_hits} lazy chunk(s)"
done

if (( FAILED != 0 )); then
  cat >&2 <<'EOF'

ci-no-password-fields-in-entry-chunk: FAILED

A password input reached a chunk that loads on every page view. The operator's
password manager will prompt on every navigation.

Fix: make sure the component is only reachable through a code-split boundary —
routes in App.tsx are `React.lazy(() => import(...))`, and any password form
outside a route (a modal in Header/Layout/a provider) must be lazy-loaded too.
An INEFFECTIVE_DYNAMIC_IMPORT warning during the build means something still
imports it statically, which pulls it straight back into the entry chunk.
EOF
  exit 1
fi
echo "ci-no-password-fields-in-entry-chunk: OK"
