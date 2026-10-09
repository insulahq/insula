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
| `run-failed` | the script exited non-zero. Blocks the rest **unless it declares `# blocks-on-failure: no`** |
| `blocked` | queued behind a blocking `run-failed` script; not itself broken |
| `skipped` | an operator recorded a `.skipped` marker — it never ran, and it does not block |
| `already-applied` | a `.done` marker exists (ran on an earlier pass) — **or**, flagged `baseline`, a `.baseline` marker: a fresh bootstrap of that release already produced its end state, so it **never ran here** (see [Fresh nodes](#fresh-nodes-baseline-markers-adr-056-5)). Not listed per line; the summary counts baselines: `36 shipped (32 baseline)` |

A repeat failure states how long it has been repeating, so a wedge is legible at
a glance rather than looking like a fresh problem:

```
run-failed  2026.7.1/0001-… — <error>  (attempt 840, failing since 2026-07-01)
host-config host-migrations: 11 migration(s) BLOCKED behind 2026.7.1/0001-… — see …
```

Per-node markers live at `/var/lib/platform/host-migrations/<version>/<name>.sh.<kind>`,
one of `.done` (ran), `.skipped` (operator decision, ADR-056 §2) or `.baseline`
(a fresh bootstrap already reflects it, ADR-056 §5); `.failing` is failure
bookkeeping, not a completion record. A script with none of the three is "not
applied on this node" — they are per node, so check each one. Precedence when
several exist: `.done` > `.skipped` > `.baseline`; none of them ever re-runs.

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

## When a migration can never succeed (ADR-056)

Retrying only fixes *transient* failures. A deterministic one — a precondition
retrying cannot change, like stale Helm values a newer chart schema rejects —
repeats forever, and before ADR-056 it parked every later migration with it.

Two ways out, in order of preference:

1. **Fix the underlying condition**, then `insula host-config apply`. Always try
   this first; the migration exists for a reason.
2. **Record a skip** when the migration is genuinely not applicable to this host
   and never will be:
   ```bash
   V=2026.7.1; N=0001-infra-chart-bumps-cert-manager-traefik-cnpg.sh
   printf 'stale runtimeClassName in the stored release; values cleared by hand 2026-08-05\n' \
     > /var/lib/platform/host-migrations/$V/$N.skipped
   ```
   The node then reports it as **`skipped`** with that reason — never `applied` —
   and the chain proceeds.

> **Do not `touch` the `.done` marker.** It was the only escape hatch before
> ADR-056 and it *lies*: the node reports `applied` for a script that never ran,
> which the next incident responder has to unpick. Use `.skipped`.

### For migration authors

- **Exit 0** for applied, already-satisfied, **and not-applicable-to-this-host** —
  printing why. A precondition retrying can never change is *not* a failure.
- **Exit 1** only when you genuinely attempted the change and it failed.
- Add `# blocks-on-failure: no` **iff nothing later depends on your script.** The
  header is optional and absent means `yes`, so the safe default holds; CI
  rejects any value other than `yes`/`no`.

## Fresh nodes: `.baseline` markers (ADR-056 §5)

A freshly bootstrapped node starts with an **empty** ledger, so without a
baseline its first converge replays **every migration ever shipped**. That is
wrong twice over: `bootstrap.sh` at release X already produces the end state of
every migration ≤ X (a bootstrap change reaches fresh installs; the migration
only backfills existing nodes), and replaying cluster-scoped history is
dangerous. Production, 2026-10-01: a newly joined second server replayed all 36 —
one re-applied the Calico operator manifest cluster-wide, one restarted k3s
(stalling a 2-member etcd for ~13 s), and one began failing every hour.

**When it is written.** `bootstrap.sh` stamps the ledger on a **fresh node only**
— a run whose own k3s install happened in this invocation — right after it
installs the operator CLI, with the release it is installing:

```bash
insula host-config baseline --up-to "$(cat platform/VERSION)"
```

A re-run of bootstrap over an existing install never calls it.

**What it does.** For every valid shipped script with version **≤ `--up-to`** that
has no `.done`, `.skipped` or `.baseline` marker yet, it writes
`<version>/<name>.sh.baseline`, whose first line reads:

```
baseline: fresh bootstrap of 2026.10.2 at 2026-10-01T12:34:56Z — never run on this node
```

The converge then reports those as `already-applied` with `baseline: true`, and
never runs them. Scripts **newer** than `--up-to` stay pending and run on the next
converge as usual. The command is idempotent — a second run stamps nothing.

| exit | meaning |
|---|---|
| `0` | stamped (or nothing left to stamp) |
| `1` | failed — a marker write failed, the ledger is unreadable, or the binary has no catalog |
| `2` | usage — `--up-to` missing or not CalVer, unknown flag |
| `3` | **refused** — this node already has converge history (any `.done` or `.failing` marker) |

**Why it refuses an existing node.** On a node that has already converged, some
migrations ≤ `--up-to` may genuinely still be pending; a baseline there would
silently skip them. `--force` overrides the check, and the marker then carries a
second `forced:` line so the record never overstates how fresh the node was.
Always `--dry-run` first — it lists exactly what would be stamped, and predicts a
refusal with the same exit code.

**Why not `.done`.** ADR-056 rejected touching `.done` for a script that never
ran: `applied` must mean *it ran here*. `.baseline` says something different and
true — *the bootstrap of release X already left the host in this state* — and the
admin panel shows it (`36 applied (32 baseline)`), so an incident responder can
tell the two apart.

**Undo one.** Delete the `.baseline` file; the next converge (or
`insula host-config apply`) runs that script — they are idempotent.

**A node joined before this existed** has already replayed everything; its `.done`
markers are true records and need nothing. For a replayed migration that now
fails every hour, fix the condition, or — if it is genuinely not applicable to
this host — record a `.skipped` with the reason (above).

## If a node never converges at all

!!! danger "The timers were never installed (bootstraps before v2026.8.21)"
    This is the one that hides. `phase_platform_ops` short-circuited on *"already
    at &lt;version&gt;"* and returned **before** installing the systemd units — and the
    documented install puts the signed binary at `/usr/local/bin/insula`
    *before* running `insula bootstrap`, so that branch was taken on the very
    **first** install. The node then had **no** `platform-ops-update.timer` (the
    CLI never self-upgrades) and **no** `platform-ops-host-config.timer`
    (**no host-migration ever runs**).

    Nothing reported it: **Platform → Host migrations** showed *"No node has
    reported yet"*, which reads as "wait", and every other page was green. The
    production cluster sat two weeks and 17 releases like this with an empty
    `/var/lib/insula/host-migrations`, missing — among others — the traefik
    `wait-for-plugin-registry` fix for its own outage.

    **Detect:**
    ```bash
    systemctl list-timers | grep platform-ops   # expect TWO timers
    ls /var/lib/insula/host-migrations          # empty == never converged
    insula --version                            # far behind the release? same cause
    ```

    **Fix** (root shell on the node; both steps idempotent):
    ```bash
    insula self-upgrade          # installs/repairs the timers, then converges
    # if the timers are still absent, re-run the installer:
    insula bootstrap
    # verify:
    systemctl start platform-ops-host-config.service
    ls /var/lib/insula/host-migrations           # should no longer be empty
    ```

    There is **no in-cluster remedy** and that is deliberate: the
    `host-config-reconciler` DaemonSet is observe-only (read-only mounts, all
    capabilities dropped, `readOnlyRootFilesystem`), so nothing in the cluster
    can write a systemd unit. The panel therefore shows the commands instead of
    a button that could not work.

    From **v2026.8.21** the admin panel flags this directly: a node past its
    first hourly converge window with no host-migration state is marked
    **never converged** and carries these commands inline.

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
  binary. But a release's migrations ship INSIDE that binary, and a node fetches
  it on its own `platform-ops-update.timer` — daily, with up to an hour of jitter
  — so they land 0–25 h after the release's containers, not at upgrade time.
  Until then the node reports its older CLI (`cliVersion`) and the admin panel
  shows it as catching up. To apply a release's host changes on a node now:
  `systemctl start platform-ops-update.service`. (ADR-064 plans for the upgrade
  itself to push this to every node; until that ships, this is the way.)

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
