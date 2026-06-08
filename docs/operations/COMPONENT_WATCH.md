# Component CVE & Version Watch — Operator Runbook

**Audience:** Platform operators / maintainers.
**Related:** [ADR-050](../architecture/adr/ADR-050-component-cve-watch.md) (decision + rubric), [ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md) (version spine), [SECURITY.md](../../SECURITY.md) (disclosure policy), [SECURITY_HARDENING.md](SECURITY_HARDENING.md), [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md), [CLUSTER_MAINTENANCE_AND_UPGRADES.md](CLUSTER_MAINTENANCE_AND_UPGRADES.md).

Insula ships ~65 components — from k3s and Traefik at the edge to the Fastify
backend, the Stalwart mail stack, and tenant PHP/WordPress runtimes. This runbook
is how we keep them patched: what we watch, how sensitive each one is, which CVEs
are active, what breaking changes block an upgrade, and which mitigations are in
place vs still owed.

It complements — does not replace — two existing systems:

- **Version spine** (ADR-045): tracks *our own* releases (`platform/VERSION` →
  version-poller → installed/running/available). This runbook tracks *upstream*
  components. When an upstream CVE forces a bump, the fix flows out through the
  version spine.
- **[SECURITY.md](../../SECURITY.md)**: how *external reporters* report bugs in
  *our* code. This runbook is how *we* watch *upstream* components we deploy.

## The model

Three artifacts, one guard:

| Artifact | Path | Role |
|---|---|---|
| **Registry** | [`security/components.yaml`](../../security/components.yaml) | Single source of truth: every component, its tier, the version we run, where it's pinned, where to watch. |
| **Ledger** | [`security/cve-ledger.yaml`](../../security/cve-ledger.yaml) | Active/triaged CVEs + the waiver register. |
| **Runbook** | this file | The process around the two files. |
| **Guard** | [`scripts/ci-component-watch-check.sh`](../../scripts/ci-component-watch-check.sh) | CI enforcement: schema · drift · coverage · SLA. |

Automation: `.github/workflows/component-watch.yml` runs a weekly sweep and opens
a rolling tracking issue; `.github/dependabot.yml` proposes dependency-bump PRs;
per-image **Trivy** scans upload to the repo **Security** tab.

```bash
scripts/component-watch.sh --status     # tiered table + open CVE counts
scripts/component-watch.sh --drift      # registry vs real pins (offline)
scripts/component-watch.sh --scan       # osv-scanner + govulncheck + cargo-audit
scripts/component-watch.sh --latest     # what's behind upstream (online; GITHUB_TOKEN)
bash scripts/ci-component-watch-check.sh # the full gate, locally
```

## Tiering rubric

Score each component 0–3 on five axes; the dominant axes drive the tier. Use this
when classifying a **new** component so tiers stay consistent.

| Axis | 3 | 2 | 1 | 0 |
|------|---|---|---|---|
| **Exposure** | internet-facing | reachable from tenant workloads | control-plane internal | build-time only |
| **Privilege** | host-root / hostNetwork / cluster-admin | broad RBAC / secret access | namespaced minimal | sandboxed |
| **Data sensitivity** | secrets/creds/TLS keys/PII | tenant data | metadata | none |
| **Blast radius** | whole-platform | single subsystem | single tenant | negligible |
| **Patch agility** (inverse) | upstream-locked, sequential/disruptive | chart/image bump, maybe breaking | we rebuild same-day | — |

| Tier | Definition | Critical/KEV | High | Medium |
|------|-----------|--------------|------|--------|
| **0 Critical** | internet-facing **and** (auth/crypto/secret/data **or** platform-wide blast) | **48 h** hotfix | 7 d | next release |
| **1 High** | privileged/host or platform-wide, **or** internet-facing single-subsystem | 7 d | 30 d | next release |
| **2 Moderate** | cluster-internal, namespaced, authenticated | 30 d | next release | best-effort |
| **3 Low** | build-time toolchain / base + utility images | next release | best-effort | best-effort |
| **C Catalog** | tenant-facing runtime images, per-tenant blast | 7 d | 30 d | best-effort |
| **X External** | consumed, not patched by us | notify + document | notify | — |

SLAs are encoded in `security/components.yaml: slas` and enforced by the guard for
`open` KEV/critical ledger items (Tier 0 = 48 h, Tier 1/C = 7 d, Tier 2 = 30 d).

## Cadence

1. **Weekly (automated)** — `component-watch.yml` runs `--scan` + `--latest`,
   diffs against the ledger, and opens/updates the rolling issue
   *"🔭 Component watch — week of YYYY-MM-DD"* listing: new CVEs, components behind
   upstream, and open ledger items past SLA. Triage that issue.
2. **Per-PR (automated)** — Infrastructure CI runs the guard (schema/drift/
   coverage/SLA — all enforcing); the dep-scan gate fails on an **untracked**
   HIGH/CRITICAL (no ledger entry at all). Triaging it into the ledger (even
   `open` with a remediation) unblocks the dep-scan gate; the SLA check then
   fails CI if an open KEV/critical sits past its tier window with no mitigation.
3. **Event-driven** — a KEV addition or a critical disclosure for a Tier 0/1
   component starts the SLA clock immediately; don't wait for the weekly issue.
4. **Quarterly (human)** — re-review tiers (§Quarterly tier review).

## Triage a finding

```
1. Affected?   Is the version we run (registry `pinned`) in the CVE's affected range?
                 no → ledger status: not_affected (note the version reasoning)
2. Reachable?  Is the vulnerable code path reachable in OUR config/usage?
                 no → status: not_affected (justify; set `reachable: false`)
3. Severity    Combine CVSS + CISA KEV + reachability. KEV or critical+reachable
                 on a Tier 0 component = page now (48 h SLA).
4. Decide      patch now | next release | mitigate (interim control) | accept (low sev)
5. Record      add/update the ledger entry; the SLA clock runs from `discovered`.
```

Add the entry to [`security/cve-ledger.yaml`](../../security/cve-ledger.yaml)
(template at the bottom of that file). Every `component` must exist in the registry.

## Research breaking changes

Before bumping a pinned version, read the upstream changelog / migration notes and
record the result in the ledger `breaking_changes` field:

- **Charts** (Traefik, cert-manager, CNPG, Longhorn, sealed-secrets): read the
  chart's `UPGRADING.md` / release notes; watch CRD/values schema changes.
- **k3s**: minor-by-minor only (the version spine + system-upgrade-controller
  enforce sequential hops); check the Kubernetes deprecation guide.
- **PostgreSQL major** (CNPG): follow [PG_MAJOR_UPGRADE.md](PG_MAJOR_UPGRADE.md).
- **Stalwart / webmail / catalog runtimes**: check config-format and data-format
  notes (Stalwart RocksDB format is pinned against `rocksdb-secondary-checkpoint`).

If an upgrade carries a breaking change, it goes in the CHANGELOG `### BREAKING`
section when shipped (ADR-045).

## Apply a fix

**Upstream component** (chart/image/binary pin):

```bash
# 1. bump the pin at its pin_source (e.g. scripts/bootstrap.sh or a k8s manifest)
# 2. update security/components.yaml `pinned` (+ app_version) to match
# 3. drift guard must pass:
bash scripts/ci-component-watch-check.sh
# 4. note the CHANGELOG (### Security / ### BREAKING), then cut a release:
scripts/cut-release.sh            # version spine surfaces it to operators
# 5. mark the ledger entry status: fixed (set `closed:`)
```

**First-party dependency** (npm / go.mod / Cargo):

```bash
# bump the lockfile (or merge the Dependabot PR), then:
scripts/component-watch.sh --scan   # OSV gate must be green
# the rebuilt image carries the fix; mark the ledger entry fixed.
```

## Mitigations — implemented vs open

When you can't upgrade immediately, record an **interim control** and keep the
remediation owed:

- `status: mitigated` + `mitigation:` — the control in place now (e.g. a WAF/CRS
  rule, a NetworkPolicy, a config flag, disabling a feature).
- `remediation:` — the real fix still owed (e.g. "bump chart → cut release").

The guard treats a `mitigated` entry as satisfying the SLA, but it stays on the
weekly issue until `status: fixed`. `accepted` requires a `review_by` date.

> **Initial backlog (2026-06-08):** the first OSV scan surfaced 9 pre-existing
> HIGH/CRITICAL dependency CVEs (`fast-jwt` 9.1, `fast-uri`, `fast-xml-parser`,
> `react-router`, `golang.org/x/oauth2`, `x/crypto`, `moby/spdystream`). All
> **fixed the same day** (PRs #251 npm + #253 Go), and the SLA check was then
> flipped from report-only to **enforcing**. The ledger keeps the fixed entries
> for audit history.

## Add / remove a component

- **Add:** append an entry to `security/components.yaml` (the **coverage** guard
  fails otherwise — every k8s image and every `bootstrap.sh` pin must map to a
  component). Pick a tier with the rubric; set `pin_source` + `pin_check`; for
  upstream components add `repos:` (the image repo path) so coverage matches.
- **Remove:** delete the manifest/pin first, then the registry entry; run the guard.

## Quarterly tier review

- Re-score components whose exposure changed (a new internet-facing route, a new
  privileged mount).
- Reconcile `--latest` output: anything > 2 minors behind upstream on Tier 0/1
  gets a planned bump even absent a CVE.
- Sweep the ledger: close stale `fixed`, re-justify each `accepted` past its
  `review_by`.

## Known hygiene items (non-CVE)

- `postgres-client-backup` runs PG **17** while the server is PG **18** — bump the
  pg_dump image to `18-alpine` so the dump client major matches the server.
- `alpine/k8s` (1.33.3 vs 1.33.4) and `busybox` (1.36 vs 1.37) each have two tags
  in use — consolidate to one.
- `roundcube-deployment.yaml` (legacy) still references `:latest-fpm`; the active
  `roundcube/deployment.yaml` is digest-pinned — remove the floating reference.
- Flux is installed via `flux install` (CLI **latest**, unpinned) — consider
  pinning to a release.

## Tool reference

| Tool | Use | Install |
|---|---|---|
| `osv-scanner` | npm/Go/Rust lockfile + image CVEs | <https://github.com/google/osv-scanner> |
| `govulncheck` | Go reachability-aware vuln scan | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| `cargo audit` | Rust crate advisories | `cargo install cargo-audit` |
| `trivy` | container image + filesystem CVEs (CI) | `aquasecurity/trivy-action` |
| `gh` | upstream release lookups for `--latest` | GitHub CLI |
