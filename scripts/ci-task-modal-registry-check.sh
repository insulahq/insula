#!/usr/bin/env bash
# ci-task-modal-registry-check.sh — every task modal the backend names must
# exist in a panel's registry.
#
# WHY. A task row's target tells a panel what to open. Nothing checked that
# the panel could honour it, and the gap was not theoretical: a tenant's
# on-demand backup enrolled `{type:'route', href:'/tenants/<id>?tab=backups'}`
# — an ADMIN path. Tenant task rows render in the TENANT panel, which has no
# `/tenants/:id` route, so a tenant clicking their own running backup went
# nowhere, and closing the progress modal abandoned the run with no way back.
# It failed silently: no error, no 404 banner, just a click that did nothing.
#
# This guard checks the modal half, which is the half with a checkable
# contract: `modal: '<key>'` in a backend task target must appear as a key in
# at least one panel's `src/tasks/modal-registry.tsx`. A typo or an
# unregistered component fails the build instead of rendering nothing.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ADMIN_REG=frontend/admin-panel/src/tasks/modal-registry.tsx
TENANT_REG=frontend/tenant-panel/src/tasks/modal-registry.tsx

for f in "$ADMIN_REG" "$TENANT_REG"; do
  [ -f "$f" ] || { echo "ci-task-modal-registry-check: missing $f"; exit 1; }
done

# Registry keys: quoted or bare object keys followed by ':'.
registry_keys() {
  grep -oE "^\s+'?[a-z0-9-]+'?\s*:\s*\{" "$1" 2>/dev/null \
    | tr -d " '{:" | sort -u
}
KEYS="$(registry_keys "$ADMIN_REG"; registry_keys "$TENANT_REG")"

# Backend-emitted keys: `modal: 'foo'` inside src, tests excluded.
EMITTED=$(grep -rhoE "modal:\s*'[a-z0-9-]+'" backend/src --include='*.ts' \
  | grep -v '\.test\.ts' | sed -E "s/.*'([a-z0-9-]+)'.*/\1/" | sort -u)

missing=0
while IFS= read -r key; do
  [ -z "$key" ] && continue
  if ! grep -qx "$key" <<<"$KEYS"; then
    echo "MISSING: backend emits task modal '$key' — no panel registry has it"
    missing=$((missing + 1))
  fi
done <<<"$EMITTED"

if [ "$missing" -gt 0 ]; then
  echo ""
  echo "Register it in $ADMIN_REG or $TENANT_REG (whichever panel receives"
  echo "that task's scope), or change the target. A key no registry knows"
  echo "renders nothing at all when the row is clicked."
  exit 1
fi

echo "ci-task-modal-registry-check: OK — $(wc -l <<<"$EMITTED") backend modal key(s), all registered."
