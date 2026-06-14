# Operator-script consolidation into the `platform-ops` CLI (plan)

> **Status:** planning (no code yet). Tracking: ROADMAP **R18**. Builds on ADR-045
> (`platform-ops` operator CLI). This doc is the classification + migration map; it
> does **not** change behaviour.

## 1. Why this exists

`scripts/` has grown to ~177 shell scripts. A few are genuine **on-node operator
actions** (`admin-password-reset.sh`, `backup-target-key-rotate.sh`, …) that each
re-implement cluster plumbing — CNPG-primary-pod resolution, bcrypt-in-a-pod,
kubeconfig handling — in bash. That duplication is where bugs live: the password-reset
script alone carries a multi-container `kubectl exec` bug (no `-c postgres` → a
"Defaulted container" warning pollutes its output) and a cosmetic leading-space quirk
that silently breaks naive captures.

ADR-045 already established the fix: **`platform-ops`**, a cosign-signed TypeScript
binary at `/usr/local/bin/platform-ops` whose subcommands **directly import the backend
`modules/`** — "the modules ARE the source of truth; the CLI and the in-cluster
controllers are two surfaces over identical code paths" (ADR-045 item 18). DR was the
first consolidation (`platform-ops dr restore`, "no standalone DR script", item 15).

This plan finishes the job for the remaining operator actions — and, critically, draws
the line for what should **stay** bash.

## 2. Current state (what `platform-ops` already does)

Built and shipping (ADR-045 "scaffolding tranche"):

```
platform-ops
  version
  cluster   status | diagnostics | upgrade
  dr        verify | restore        # already absorbs the DR driver (item 15)
  snapshot  …
  host-config …                     # ADR-045 W10 convergence model
  node | upgrade | rollback | self-upgrade | shell
  migrations  …                     # stub — registry lands later
```

**Mid-flight overlap already exists** (evidence the consolidation is real but
unfinished): `scripts/dr-restore.sh` vs `platform-ops dr restore`; `make diagnose`
(forensic snapshot) vs `platform-ops cluster diagnostics`. These are retirement
candidates pending a parity check (§5C).

## 3. Classification of all ~177 scripts

Three buckets. The bulk (CI guards + test harnesses, ~120 scripts) is unambiguous by
prefix and stays bash; the value of this plan is the ~25 operator-facing scripts.

### A. Keep-as-bash — **by design, never migrate** (~135)

| Group | Count | Examples | Why it stays bash |
|---|---|---|---|
| Bootstrap / build / release | ~5 | `bootstrap.sh`, `build-platform-ops.sh`, `cut-release.sh`, `new-host-migration.sh`, `install-git-hooks.sh` | **Chicken-and-egg:** `bootstrap.sh` *installs + cosign-verifies* the CLI, so it can't be a subcommand. Build/release run in CI, not on-node. |
| Dev / local | ~4 | `local.sh`, `setup-local-test.sh`, `local-private-worker-sample.sh` | Developer surface; never touches a production node. |
| CI guards | ~45 | every `ci-*.sh` | CI-only invariants over the repo. Not an operator surface at all. |
| Test / integration / smoke / bench / spike | ~75 | `integration-*.sh`, `test-*.sh`, `smoke-test*.sh`, `*-e2e.sh`, `failover-test.sh`, `bench-*`, `spike-*`, `tests/*` | Dev/test harnesses. (A future `platform-ops selftest` umbrella is possible but explicitly out of scope.) |
| Shared libs / initdb | ~6 | `lib/*.sh`, `postgres-initdb/*.sh` | Support the above; not invoked directly by operators. |

### B. Migrate → `platform-ops` subcommand (genuine on-node operator actions)

Each imports the existing backend module (no logic re-implementation) and gets a
`dispatch.test.ts` case, `--help`, and `--json`.

| Script (LOC) | → command | Backend module it should import | Notes |
|---|---|---|---|
| `admin-password-reset.sh` (269) | `admin reset-password` | `auth/service.ts` (hash) | **+ keep a thin break-glass bash** (§4). Kills the `-c postgres` bug class. |
| `admin-domain-rewrite.sh` (155) | `domain set` / fold into `domain rename` | `platform-domain/service.ts`, `system-settings/service.ts` | Overlaps the **API-only** `POST /admin/platform-domain/rename` shipped in R16 — the CLI should call the same `renamePlatformDomain()`. |
| `backup-target-key-rotate.sh` (251) + `make backup-target-key-status` | `backup rotate-key` / `backup key-status` | backup-target key module | DESTRUCTIVE → explicit `--confirm` gate. |
| `generate-stalwart-secret.sh` (201) | `mail init-secrets` | `mail-admin/*` | Also runs at bootstrap-time; CLI re-run for rotation. |
| `component-watch.sh` (160) | `component-watch` | component CVE/version-watch module (ADR-050) | Operator helper; runbook-referenced. |
| `cleanup-orphaned-namespaces.sh` (141) | `cluster gc-namespaces` | tenant-namespace reconciler | |
| `restore-{etcd,mail,postgres}-from-shim.sh` (155/159/218) | `dr restore --component <etcd\|mail\|postgres>` | DR restore module | R-X11 component restores fold under the existing `dr restore`. |
| `upgrade-cnpg.sh` (153) | `cluster upgrade-cnpg` (or fold into `cluster upgrade`) | upgrade module | |
| `node-terminal-cleanup-stale-artifacts.sh` (97) | `node-terminal gc` | node-terminal module | Confirm it isn't already a CronJob first. |
| `firewall-probe.sh` (84) | fold into `cluster diagnostics` | firewall module | Overlap with existing diagnostics. |
| `make secrets-fetch` / `secrets-restore` → `lib/apply-secrets-bundle.sh` | `secrets fetch` / `secrets restore` | secrets-bundle module | **Open decision (§7):** these run workstation→remote over SSH — different execution context. |

### C. Retire — one-shots already run, or superseded by the CLI

| Script | Disposition |
|---|---|
| `dr-restore.sh` (610), `dr-restore-bundle.sh` (77) | **Parity-check against `platform-ops dr restore`, then delete.** |
| `make diagnose` | Reconcile with `cluster diagnostics`; keep one. |
| `migrate-cluster-to-substituteFrom.sh`, `migrate-stalwart-default-hostname.sh`, `migrate-stalwart-tls-bootstrap.sh`, `migrate-valkey-bootstrap.sh`, `cutover-stalwart-v015-to-v016.sh`, `mail-stack-consolidate.sh` | One-time migrations already applied. Move to `scripts/archive/` (or delete — git history retains). |
| `apply-backup-labels.sh`, `backfill-tenant-namespace-pss.sh`, `storage-snapshot-backfill.sh` | One-shot backfills. Same disposition. |
| `spike-*.sh`, `stalwart-016-spike.sh`, `rclone-shim-eval/*`, perf benches (`bench-*`, `*-perf.sh`) | Research artifacts. Archive. |

## 4. Break-glass policy (the load-bearing rule)

Some operator actions exist precisely **to recover a broken platform** — a password
reset when the panel is down, a DR/secret restore on a fresh node. For those:

1. The **`platform-ops` subcommand is canonical** — it imports the service module, so
   there is exactly one tested code path (and bugs like the `-c postgres` one are fixed
   once, in TS, with a `dispatch.test.ts` guard).
2. Every recovery subcommand **keeps a thin, deliberately dependency-light bash
   fallback** that needs only `kubectl` + the in-cluster pods — **not** the signed
   binary. This survives the one scenario the CLI can't: the binary itself is
   missing/unverified/broken. `admin-password-reset.sh` becomes exactly this (re-scoped,
   documented as break-glass, bugs fixed).
3. The fallback is **not** a second implementation of business logic — it does the
   minimum (e.g. bcrypt-in-pod + one `UPDATE`) and is explicitly labelled "emergency
   only; prefer `platform-ops admin reset-password`."

Non-recovery actions (key rotation, namespace GC, component-watch) get **no** bash
fallback — CLI only.

## 5. Migration order (tranches)

- **T0 — this plan.** Classification + ROADMAP R18 + ADR-045 addendum. *(this PR)*
- **T1 — prove the pattern, max pain relief.** `admin reset-password` + `domain rename`.
  Both already have backend service modules → thin CLI wrappers. Re-scope
  `admin-password-reset.sh` to break-glass; retire `admin-domain-rewrite.sh` into
  `domain`. Add the §6 guard.
- **T2 — DR + secrets.** Fold `restore-*-from-shim.sh` under `dr restore --component`;
  decide secrets-fetch/restore (§7); parity-check and delete `dr-restore.sh` + reconcile
  `make diagnose`.
- **T3 — housekeeping actions.** `backup rotate-key/key-status`, `component-watch`,
  `cluster gc-namespaces`, `cluster upgrade-cnpg`, `node-terminal gc`.
- **T4 — retire one-shots.** Move §5C migrations/backfills/spikes to `scripts/archive/`.

## 6. Guardrail (prevent regrowth)

A new CI guard (`ci-operator-script-placement.sh`, always-run) that **fails when a new
`scripts/*.sh` is added that looks like an on-node operator action** (greps for
`kubectl … exec`/secret writes/DB mutation) **unless** it is (a) a `ci-*`/`test-*`/
`integration-*`/bootstrap script, or (b) on an explicit break-glass allowlist. This
forces new operator actions to land as `platform-ops` subcommands. Companion to the
identifier guard added in this branch.

## 7. Open decisions (need an answer before T2)

1. **`secrets fetch/restore`** run from the operator's **workstation against a remote
   host over SSH** — not on-node. Options: (a) a `platform-ops secrets` subcommand that
   SSHes (CLI grows a remote-exec mode); (b) keep as `make`/bash (different context, leave
   it). *Recommendation: keep as `make` for now; revisit if the CLI gains a remote mode.*
2. **Retire = delete vs `scripts/archive/`** for one-time migrations. *Recommendation:
   `scripts/archive/` with a README, so the host-migration registry (ADR-045 W10c) can
   reference prior migrations without `git log` spelunking.*
3. **`destroy-cluster.sh`** (DESTRUCTIVE wipe): make it `cluster destroy --confirm` or
   keep standalone? *Recommendation: keep standalone — it intentionally works on a
   half-dead cluster, same logic as break-glass.*

## 8. Non-goals

- Migrating CI guards or test/integration harnesses (they are not operator surface).
- A Go rewrite of any logic (ADR-045 item 17/18 — TS modules stay the source of truth).
- Changing `bootstrap.sh`'s scope (it installs the CLI; it cannot depend on it).
