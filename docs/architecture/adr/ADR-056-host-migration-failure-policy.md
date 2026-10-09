# ADR-056: Host-migration failure policy — blocking scope, escape hatch, escalation

**Status:** Proposed (2026-08-05) · Amended 2026-10-01 (§5, `.baseline` markers) · Amended 2026-10-09 by ADR-064 (§6)

Amends [ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md) W10c, which
introduced host-migrations: per-release one-shot bash scripts embedded in the
signed `platform-ops` binary and run host-side, per node, by the `host-config`
converger. W10c fixed the execution model. It did not answer what happens when a
migration *fails*, and the default it fell into turns out to wedge a cluster's
host layer indefinitely.

## Context

The runner halts on the first failure and marks every later script `blocked`.
That is the correct default — a later migration may assume an earlier one applied,
and advancing past a failure risks a half-migrated host.

The cost of that correctness, as shipped, is total:

1. **One failure parks every later migration, forever.** There is no scope to the
   blocking: an unrelated script queued behind a failure is blocked just as hard
   as a dependent one. Most migrations are mutually independent — "install
   rclone", "open the SFTP firewall port", "bump the cert-manager chart" have
   nothing to do with each other.
2. **Retry is the only recovery, and it only helps transient failures.** The
   converge retries on its timer (hourly since v2026.8.3, previously daily).
   A *deterministic* failure is retried forever with the same result.
3. **There is no escape hatch.** The only way an operator can move past a
   permanently-broken migration is to `touch` its `.done` marker — undocumented,
   and it makes the node report `applied` for a script that never ran.
4. **Nothing escalates.** A blocked chain is silent. No alert, no counter, no
   record that the node has been stuck since a particular date.

### This is not hypothetical

The DEV cluster has been wedged since **2026-07-01**: `0 applied, 11 pending`
behind a single `run-failed`. The cause is deterministic —
`2026.7.1/0001-infra-chart-bumps-…` runs `helm upgrade --reuse-values`, and the
release's stored values carry a `runtimeClassName` key that the newer
cert-manager chart schema rejects. Retrying cannot fix stale stored values, so
the same failure has repeated for five weeks, and eleven unrelated migrations sat
behind it. Nobody noticed until someone went looking.

The failure mode also **compounds**: every subsequent release adds migrations
behind the wedge, so the backlog grows, and whenever it is finally cleared the
node applies a large batch at once — a riskier operation than the incremental
path the design intends.

### It is partly an authoring problem

`2026.7.1/0001` fails on a precondition it can never satisfy by retrying. A
migration in that position should report *"the world is not what I expected —
not applicable"* and exit 0 loudly, rather than exit 1 forever. The runner cannot
distinguish those two cases; only the script can.

## Decision

Four changes, smallest-blast-radius first (a fifth, §5, was added by amendment).

### 1. Blocking becomes a per-migration declaration

A new header, parsed like the existing `# idempotent:` / `# allow-paths:`
contract:

```bash
# blocks-on-failure: yes    # default when the header is absent
```

`yes` (or absent) keeps today's behaviour: a failure halts the chain. `no`
declares the script independent — its failure is recorded, and later migrations
still run.

**Default stays `yes`.** Opting out is a claim the author makes about their own
script, reviewed like any other code. A migration that bumps a chart everything
else depends on keeps `yes`; one that opens a firewall port declares `no`.

### 2. An auditable skip marker

`<marker-dir>/<version>/<name>.skipped` — written deliberately by an operator,
carrying a reason and a timestamp. A skipped script is reported as **`skipped`**,
never `applied`, and does not block. This replaces the `touch …done` hack, which
silently falsifies the node's state.

The distinction matters during incident response: `applied` means it ran,
`skipped` means a human decided it should not.

### 3. Failures are counted and escalate

Each failure records an attempt count and a first-seen timestamp alongside the
migration. The converge output escalates with them, so a wedge announces itself:

```
run-failed  2026.7.1/0001-… — <error>  (attempt 840, failing since 2026-07-01)
```

Retrying does **not** stop — an operator fixing the underlying cause must be
picked up automatically. What changes is that the state stops being silent.

### 4. The authoring contract distinguishes "not applicable" from "failed"

Documented in the runbook and in `scripts/new-host-migration.sh`'s stub:

- **exit 0** — applied, already satisfied, *or* not applicable to this host.
  Print why.
- **exit 1** — genuinely attempted and failed.

A precondition that retrying cannot change is *not applicable*, not a failure.

### 5. A fresh node's ledger is baselined, not replayed (amendment, 2026-10-01)

A freshly bootstrapped node starts with an **empty** ledger, so its first converge
replayed every migration ever shipped — even though `bootstrap.sh` at release X
already produces the end state of every migration ≤ X (the project invariant: a
bootstrap change reaches fresh installs, the migration backfills existing nodes).
On production a newly joined second server replayed all 36: one re-applied a
Calico operator manifest cluster-wide, one restarted k3s (stalling a 2-member etcd
for ~13 s), and one began failing every hour.

A third marker kind, `<marker-dir>/<version>/<name>.baseline`, records *"a fresh
bootstrap of release X already reflects this migration; it was never run on this
node"*. `insula host-config baseline --up-to <X>` writes it for every valid shipped
script ≤ X with no marker yet; `bootstrap.sh` calls it on a **fresh node only**
(its own k3s install happened in that run). The runner treats `.baseline` as
applied — never runs it — and reports it as `already-applied` with
`baseline: true`, carried through `status.json`, the reconciler relay and the
admin panel. Precedence: `.done` > `.skipped` > `.baseline`.

It is **not** `.done`, for the same reason §2 rejected touching `.done`: `applied`
must keep meaning *it ran here*.

Safety: the command **refuses** (exit 3) when the ledger already shows converge
history — any `.done` or `.failing` marker — because on an existing node some
migrations ≤ X may genuinely still be pending, and a baseline would skip them
silently. `--force` overrides and the marker then records that it was forced.
Scripts newer than X are never stamped: the bootstrap did not produce them.

### 6. Phases, descriptions, and when a failure stops an upgrade (amendment, ADR-064)

[ADR-064](ADR-064-one-upgrade-procedure-nodes-first.md) makes host-migrations part of
the upgrade run. Each script now also declares `# phase: before-services` (runs while
the previous release's services still run — the default, and the only phase a node
applies before the services roll) or `after-services` (the converge defers it until
the platform-version ConfigMap reaches its release), and a one-line `# description:`
the upgrade review shows. Both are required from 2026.10.7 (CI).

The failure policy itself is unchanged — a failed script still blocks every later
one on its node, counts its attempts and escalates — but its effect on an upgrade
is now explicit: the pre-flight's **No failed host change on a node** gate blocks a
production upgrade onto a node with a failed or blocked script (fix it or record a
skip first), and a failure while the run updates the nodes stops the run **before**
the services change.

## Alternatives considered

**Continue past every failure.** Rejected — it is precisely the half-migrated
state the halt exists to prevent, and it would apply to dependent migrations too.

**Stop retrying after N attempts.** Rejected as the primary mechanism: it turns a
visible-but-recoverable state into a stuck one, and an operator who fixes the
cause would then have to know to re-arm it. Escalation without stopping gets the
attention without the trap.

**Baseline by touching `.done` on a fresh node (§5).** Rejected — it is the very
lie §2 removed: the node would report `applied` for 36 scripts that never ran.

**Make every migration a no-op on a fresh node instead (§5).** Rejected — it moves
the burden onto every author forever, for a property the bootstrap already
guarantees, and one forgotten guard re-creates the outage.

**Relax `ProtectSystem=strict` on the self-upgrade unit.** Different bug, already
fixed separately by dispatching the converge to
`platform-ops-host-config.service`. Noted here only because it was the *reason*
migrations were failing at upgrade time; it does not change the failure policy.

## Consequences

- A single broken migration no longer wedges unrelated ones — provided authors
  declare independence. Migrations that do not declare it keep today's safe
  default, so nothing regresses silently.
- Operators gain a recorded, honest way out of a permanently-broken migration.
- A wedge is visible in the converge output from the first escalation, instead of
  being discovered by archaeology.
- The `blocks-on-failure` claim is a new thing reviewers must get right. It is
  enforced only by review and by the default being safe.
- Per-node state grows three marker kinds (`.skipped`, failure counters, and
  §5's `.baseline`). All are small files under the existing marker dir.
- A fresh node's first converge runs only migrations newer than the release it
  was bootstrapped at (§5). The guarantee is only as good as the invariant behind
  it: a migration whose end state `bootstrap.sh` does NOT also produce would be
  skipped on fresh nodes. `ci-migration-coverage.sh` enforces only the other
  direction (every bootstrap change ships a migration); this one — every
  migration is also reflected in bootstrap — rests on review.
- The admin-panel surface is delivered, and it cost **no new privilege**. The
  converge writes a node-local `status.json`; the `host-config-reconciler`
  DaemonSet — already on every node, already publishing one per-node ConfigMap —
  relays it through a **read-only** mount. Publishing from platform-ops itself
  was rejected: a worker's kubeconfig is `get` on five ConfigMaps, and RBAC
  cannot scope `create` by `resourceName`, so granting it would let any worker
  create any ConfigMap in `platform-system`.
- There is deliberately **no Retry button**. The backend cannot touch a node's
  filesystem, and the converge that applies migrations already runs hourly and
  picks up a fixed condition by itself — a button that waited an hour would be
  theatre. The panel shows the cause, the attempt count and age, and the two
  commands that resolve it.
