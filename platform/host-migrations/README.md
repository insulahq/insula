# Host-migrations (ADR-045 W10c)

Per-release **one-shot imperative bash scripts** run as **root** on every node by
`platform-ops host-config`. Use these for host-level changes that are not
expressible as a declarative sysctl (W10) or package (W10b) — e.g. rewriting a
config file, relabelling a mount, a one-time data move.

## How they ship & run

- Scripts live here at `platform/host-migrations/<version>/<NNNN-name>.sh`.
- The build **embeds** them into the `platform-ops` binary as SEA assets, so they
  travel with every binary — a node that self-upgrades automatically receives the
  new release's scripts (no separate sync).
- On each daily `host-config apply`, the runner walks all shipped scripts in
  `(version, name)` order, **skips** any already applied (per-node marker at
  `/var/lib/platform/host-migrations/<version>/<name>.done`), and runs the rest.
- **Opt-in**: scripts only run when the `host-migrations-desired` ConfigMap has
  `mode: enforce` (default `observe` = report-only). `host-config status` always
  dry-runs.
- **Halt on first failure** — later scripts become `blocked`; the run is
  operator-resumable (fix + re-run continues where it stopped).
- **Skip-multiple**: a node N releases behind walks the whole backlog in order.

## Authoring contract (enforced by `scripts/ci-host-migrations-check.sh`)

Every script MUST:

1. Live under a CalVer version dir (e.g. `2026.6.3/`) and be named
   `NNNN-kebab-name.sh` (zero-padded numeric prefix orders within a version).
2. Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
3. Be **idempotent** — re-running on a node where it already applied is a no-op
   (the runner's marker guards this, but be defensive: guard your own writes).
4. Be **self-contained relative to ordering** — it may assume earlier-numbered
   scripts have run, but NEVER that "we were on version X when this runs".
5. Be **order-stable** — once shipped, a script's path is its contract: never
   rename, renumber, or edit its body.
6. Carry two header comments documenting the contract:
   - `# idempotent: <how re-running is safe>`
   - `# allow-paths: <the host paths this script may touch>`  ← a review-time
     allow-list; any host path outside it requires a `### BREAKING` CHANGELOG note.

Scripts run via `bash` from **stdin** (no temp file), so do not rely on `$0` or
`$BASH_SOURCE`. They get a clean minimal environment (`PATH`, `HOME` only) and a
10-minute timeout.

### Example

```bash
#!/usr/bin/env bash
# idempotent: only writes the drop-in if its content differs
# allow-paths: /etc/systemd/journald.conf.d/
set -euo pipefail
dir=/etc/systemd/journald.conf.d
want='[Journal]\nSystemMaxUse=500M\n'
mkdir -p "$dir"
printf '%b' "$want" > "$dir/.platform-cap.new"
if ! cmp -s "$dir/.platform-cap.new" "$dir/00-platform-cap.conf" 2>/dev/null; then
  mv "$dir/.platform-cap.new" "$dir/00-platform-cap.conf"
  systemctl restart systemd-journald
else
  rm -f "$dir/.platform-cap.new"
fi
```

## Forcing function — when a migration is REQUIRED

`scripts/ci-migration-coverage.sh` (CI) fingerprints the host-firewall shape
rendered by `scripts/bootstrap.sh` (nft set declarations + input-chain
drop/accept rules) and compares it to the committed baseline
`scripts/.firewall-shape.sha256`. **A PR that changes that shape MUST** either:

1. add a host-migration here that idempotently backfills the change onto
   existing nodes, **and** refresh the baseline
   (`./scripts/ci-migration-coverage.sh --update-baseline`, commit the hash); or
2. carry a `[no-host-migration]` token (with a reason) in a commit message —
   only when existing nodes genuinely don't need the change — **and** refresh
   the baseline.

Otherwise the build fails. This is why the firewall-blacklist gap (2026-06-06 —
an nft rule that only fresh installs got) cannot recur silently. It will become
unnecessary once firewall rules are continuously converged (Tier 2); until
then it is the guardrail.
