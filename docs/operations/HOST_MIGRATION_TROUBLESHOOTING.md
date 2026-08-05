# Host-migration troubleshooting

> Host-migrations (ADR-045 W10c) are per-release bash scripts embedded in the
> signed `platform-ops` binary and run **host-side, per node** by the
> `platform-ops host-config` converger in `enforce` mode. Flux never runs them —
> it only applies app overlays.

## Why this page exists

A host-migration that fails does three things that are easy to miss:

1. It **blocks every later migration.** The runner halts on the first failure by
   design — later scripts may assume earlier ones applied, so continuing past a
   failure risks a half-converged host. Everything after it reports `blocked`.
2. It **retries only on the converge timer.** Since v2026.8.3 that timer is
   **hourly** (it was daily + up to 1 h jitter, i.e. ~25 h between attempts).
3. Until v2026.8.3 a failure during a platform upgrade reported only an exit
   code. It now carries the converge output with it.

## Check the state

On any **server** node:

```bash
insula host-config          # dry-run for the operator-content surfaces,
                            # ENFORCE for host-migrations (that is the default policy)
```

The migration line is what matters:

```
host-config host-migrations enforce [embedded]: 1 applied, 0 pending, 19 shipped
  applied          2026.8.3/0001-stalwart-spam-sample-retention.sh
  run-failed       2026.7.1/0001-infra-chart-bumps-….sh — <error>
  blocked          2026.7.1/0002-….sh
```

| state | meaning |
|---|---|
| `applied` | ran successfully, or was already satisfied; a marker exists |
| `pending` | shipped in this binary, not yet run |
| `run-failed` | the script exited non-zero — **this is what blocks the rest** |
| `blocked` | queued behind a `run-failed` script; not itself broken |

Per-node markers live at `/var/lib/platform/host-migrations/<version>/<name>.sh.done`.
A missing marker means "not applied on this node" — they are per node, so check
each one.

## Fix a `run-failed` migration

1. **Read the error on the line itself.** Since v2026.8.3 the post-upgrade
   converge also prints the cause rather than just `exited 1`:
   ```bash
   journalctl -u platform-ops-update.service --no-pager | tail -20
   journalctl -u platform-ops-host-config.service --no-pager | tail -40
   ```
2. **Fix the underlying condition on the host**, then re-run the converge:
   ```bash
   insula host-config apply       # same thing the hourly timer runs
   ```
   Migrations are idempotent, so re-running is always safe. A script that has
   already applied is skipped via its marker.
3. **Confirm the chain drained** — `0 pending`, no `blocked`:
   ```bash
   insula host-config | grep host-migrations
   ```

### Known cause: a chart bump rejected by a newer values schema

`helm upgrade --reuse-values` carries the release's *existing* values forward. If
a chart has since tightened its schema, a value an older install set can now be
rejected:

```
run-failed 2026.7.1/0001-infra-chart-bumps-… —
  at '/webhook': additional properties 'runtimeClassName' not allowed
```

That value is not set by any current manifest or by `bootstrap.sh` — it is stale
state in that one cluster's stored Helm release. Clear it deliberately (inspect
first, then `helm upgrade` without the offending key) rather than by re-running
the migration, which will keep reproducing it.

## If a node never converges at all

- **Worker nodes have no k3s admin kubeconfig.** They read desired-state through
  a least-privilege kubeconfig written by the `host-config-kubeconfig` DaemonSet
  at `/etc/platform/host-config/kubeconfig`. If that file is missing, the
  converger reports the cluster unreachable and does nothing.
- **Check the timer is actually enabled:**
  ```bash
  systemctl list-timers | grep platform-ops
  systemctl status platform-ops-host-config.timer
  ```
  Expect `OnCalendar=hourly` from v2026.8.3 onward. An operator-customised
  schedule is deliberately left alone by the migration that changes it.
- **`platform-ops` self-upgrade also converges** immediately after replacing the
  binary, so a release's migrations normally land at upgrade time rather than
  waiting for the timer.

## Deliberate opt-out

Host-migrations run because the `host-migrations-desired` ConfigMap in
`platform-system` has `mode: enforce` (the default). An operator can set
`mode: observe` for report-only; nothing then applies until it is set back.

```bash
kubectl -n platform-system get cm host-migrations-desired -o yaml
```

## Related

- [Cluster maintenance and upgrades](CLUSTER_MAINTENANCE_AND_UPGRADES.md)
- ADR-045 (host-side convergence, W10/W10b/W10c)
- `scripts/new-host-migration.sh` — scaffolds a contract-complete migration
- `scripts/ci-host-migrations-check.sh` — the authoring contract CI enforces
