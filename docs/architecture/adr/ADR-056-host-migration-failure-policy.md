# ADR-056: Host-migration failure policy — blocking scope, escape hatch, escalation

**Status:** Proposed (2026-08-05)

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

Four changes, smallest-blast-radius first.

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

## Alternatives considered

**Continue past every failure.** Rejected — it is precisely the half-migrated
state the halt exists to prevent, and it would apply to dependent migrations too.

**Stop retrying after N attempts.** Rejected as the primary mechanism: it turns a
visible-but-recoverable state into a stuck one, and an operator who fixes the
cause would then have to know to re-arm it. Escalation without stopping gets the
attention without the trap.

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
- Per-node state grows two marker kinds (`.skipped`, failure counters). Both are
  small files under the existing marker dir.
- Full visibility still wants the admin-panel surface (per-node status, retry).
  That needs an RBAC widening for worker nodes and a privileged execution path;
  it is deliberately out of scope here.
