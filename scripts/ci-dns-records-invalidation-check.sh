#!/usr/bin/env bash
#
# ci-dns-records-invalidation-check.sh
#
# Every panel mutation whose BACKEND path writes or removes `dns_records` rows
# must invalidate the `['dns-records']` query, or the domain's DNS Records list
# keeps serving its cached copy until the operator reloads the page.
#
# WHY THIS EXISTS
#
# Reported twice by the operator — first for ingress-route records, then for
# mail records — before it was recognised as one systemic bug. Enabling mail
# writes MX/SPF/DMARC/DKIM server-side, but `useEnableEmailDomain` invalidated
# only `email-domains` and `mailbox-usage`. The records existed on the DNS
# server and in the database; the panel just never re-asked. An audit found
# 18 mutations across both panels with the same shape.
#
# This is specifically NOT a polling problem. A DNS record has no transitional
# state to poll for — it exists or it does not — so invalidation is the correct
# and sufficient mechanism. (Contrast `useDomains`, which DOES poll, because a
# certificate genuinely sits in `pending` for a while.)
#
# Adding a mutation that touches DNS means adding it to MUTATIONS below, which
# is a deliberate, reviewed edit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "== DNS-writing mutations invalidate the dns-records query =="

python3 - "$REPO_ROOT" <<'PY'
import os
import re
import sys

repo = sys.argv[1]

# hook name -> what the backend does with dns_records when it runs
MUTATIONS = {
    'useEnableEmailDomain':  'writes MX/SPF/DMARC/DKIM',
    'useDisableEmailDomain': 'removes the mail records',
    'useRotateDkimKey':      'publishes a new DKIM TXT',
    'useActivateDkimKey':    'swaps the active DKIM record',
    'useCreateIngressRoute': 'creates A/AAAA/CNAME for the route',
    'useUpdateIngressRoute': 'may re-point them',
    'useDeleteIngressRoute': 'removes them',
    'useCreateDomain':       'provisions the zone and its records (primary mode)',
    'useDeleteDomain':       'removes the zone and its records',
}

FILES = ['use-domains.ts', 'use-email.ts', 'use-ingress-routes.ts']
PANELS = ['tenant-panel', 'admin-panel']

failures = []
checked = 0

for panel in PANELS:
    hooks_dir = os.path.join(repo, 'frontend', panel, 'src', 'hooks')
    if not os.path.isdir(hooks_dir):
        continue
    for fname in FILES:
        path = os.path.join(hooks_dir, fname)
        if not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8') as fh:
            src = fh.read()
        for hook, why in MUTATIONS.items():
            m = re.search(r'export function ' + re.escape(hook) + r'\(', src)
            if not m:
                continue
            # Bound the body at the next top-level export so a neighbouring
            # hook's invalidation cannot be mistaken for this one's. That exact
            # mistake made a first pass of this audit report a false "yes".
            nxt = src.find('\nexport ', m.end())
            body = src[m.start(): nxt if nxt != -1 else len(src)]
            if 'useMutation' not in body:
                continue
            checked += 1
            if "'dns-records'" not in body:
                failures.append(
                    f'{panel}/{fname} :: {hook} does not invalidate the dns-records query.\n'
                    f'      It {why}, so the DNS Records list is stale the moment it succeeds.\n'
                    "      Add: queryClient.invalidateQueries({ queryKey: ['dns-records'] })"
                )

if checked == 0:
    print('FAIL: matched 0 mutations - the hook names or paths are stale,',
          file=sys.stderr)
    print('      not the codebase clean.', file=sys.stderr)
    sys.exit(1)

print(f'  mutations checked : {checked}')

if failures:
    print('')
    for f in failures:
        print('FAIL: ' + f, file=sys.stderr)
    print('')
    print('FAILED', file=sys.stderr)
    sys.exit(1)

print('  OK')
PY
