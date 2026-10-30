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
a rolling tracking issue (now with a **⚠️ Tier-0 components behind upstream**
callout so critical drift isn't buried); `.github/dependabot.yml` proposes
dependency-bump PRs, including the digest-pinned Dockerfile bases (its docker
block); **first-party** image builds Trivy-scan, upload SARIF to the repo
**Security** tab, and **fail on an untracked fixable CRITICAL**
(`.github/actions/trivy-gate`, also run on the three release images in
`release.yml`); and `.github/workflows/image-cve-scan.yml` runs a weekly **Trivy
scan of the upstream images and of the first-party images production pins** —
entirely in CI (no cluster). Only findings with a fix count, ledger entries are
skipped, a fixable CRITICAL fails the run (HIGH is reported), and the results
land in the rolling issue *"🛡 Image scan — fixable HIGH/CRITICAL"*.

Why each part exists — what happened without it:

- **Report-only scans go unread.** The weekly scan was report-only and printed
  its findings into a run summary; the per-image scans only uploaded SARIF. Both
  panels shipped a critical OpenSSL CVE for months with the alert open.
- **A digest pin without an updater freezes.** Dependabot dropped the docker
  block over one unsupported cooldown key and never ran it; every `FROM` stayed
  on the digest of the day it was pinned. The guard (§5) now checks the config
  and that every Dockerfile directory is covered — GitHub reports such errors
  only in the repo's Insights tab.
- **An image is scanned when it is built.** One nobody rebuilds keeps its CVEs;
  the weekly scan covers what production pins, and Alpine/Debian final stages
  upgrade their packages at build time.
- **A scan sees only the images it lists.** The platform database
  (`imageName:`), the backup sidecar in every Postgres pod (a base64 Secret
  value), the upgrade Jobs' kubectl (a ConfigMap value), every component
  bootstrap.sh installs from a chart or manifest, and the catalog's tenant images
  were all unlisted — PostgreSQL ran with 14 fixable criticals, the
  snapshot-controller with a critical grpc CVE. The weekly scan's lists:

  | List | Source |
  |---|---|
  | upstream | `scripts/list-scan-images.sh`: `image:` in k8s/base, `scripts/lib/runtime-images.py` (backend), `script-images.py` (bootstrap.sh, host migrations), `config-images.py` (imageName, `*_IMAGE` values) |
  | first-party | `scripts/list-first-party-images.sh` (production's pins) |
  | cluster | `scripts/list-chart-images.sh` — each chart/manifest rendered at bootstrap.sh's pin |
  | catalog | `scripts/lib/catalog-images.py` — the Official Catalog's manifests |

Waivers are ledger entries. A bare ID is skipped in **every** image; give an
entry `trivy_scope: { paths: [...] }` or `{ purls: [...] }` to waive it only
there (a Go stdlib CVE in one unused binary must not hide the same CVE in
another image), or `{ images: [<repository>…] }` to waive it in those images
only — a reachability verdict is about one image's use of a package (brotli
that nginx never links is not brotli that curl decodes). The ignore file is
rendered per image (`cve-ledger-trivyignore.py --yaml --image <ref>`).

A shipped host migration's body never changes, so an image a later migration
replaces stays in its text. Its `# superseded-images: <image>… (<version>/<NNNN>)`
header says so: `script-images.py` leaves those images out, and
`ci-host-migrations-check.sh` checks the script writes them and the named
migration exists.

`--latest` (`scripts/lib/component-latest.py`) compares only stable upstream
tags shaped like the pin, at the pin's precision. When the upstream tag stream
is not the pin's, say so in the component's `watch:` — `version_repo` (a chart
released from its own repo), `tag_regex` (group 1 is the version), or
`pinned_version` (the version a digest pin stands for). A pin that is not a
version is listed as *not compared*, never as behind.

"Behind" means *take it now*. A GitHub release younger than 7 days (14 when it
changes the major — the minor on 0.x) is listed as **in soak** until its date,
the same minimum age as Dependabot's cooldown; a release with a security fix
that affects us is taken inside the soak by decision. A deliberate ceiling is
`watch.hold: { below: "<version>", reason: "…" }` — versions at or above it are
listed as **held** with the reason, and the pin is compared with the newest
release under it (k3s held below 1.37 still shows 1.36.6 as behind). The guard
requires a reason. The weekly sweep lists soaks and holds under *Waiting*.

```bash
scripts/component-watch.sh --status        # tiered table + open CVE counts
scripts/component-watch.sh --drift         # registry vs real pins (offline)
scripts/component-watch.sh --scan          # osv-scanner + govulncheck + cargo-audit
scripts/component-watch.sh --latest        # what's behind upstream (online; GITHUB_TOKEN)
scripts/component-watch.sh --changelog <id> # upstream releases pinned→latest, breaking changes flagged
bash scripts/ci-component-watch-check.sh   # the full gate, locally
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
   The same gate also fails on **any malicious (`MAL-`) package** — see
   *Malicious packages* below; those follow different rules.
2b. **Daily (automated)** — the dep-scan + registry guard run unattended at 04:17
   UTC. A package already in the lockfile can be compromised without anything in
   this repo changing, so a PR-only trigger would never re-examine it; daily
   bounds "advisory published → we notice" to ~24 h instead of a week.
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

## Malicious packages (`MAL-`) — different rules

A `MAL-` advisory is not a CVE. It does not mean a package we depend on has a bug;
it means the **published artifact is hostile** — a hijacked maintainer account, an
injected install script, a credential stealer. The 2026-08 keyv/`@adminide-stack`
wave was ~443 such packages, none of which was ever "vulnerable".

Two rules follow, and the gate enforces both:

- **Severity is not consulted.** Most `MAL-` advisories carry no CVSS at all. Under
  the ordinary vulnerability rules an unknown severity is a warning, so until
  2026-08-06 a malicious package printed a ⚠ and the gate exited 0. It now blocks
  regardless of score.
- **Only `not_affected` or `fixed` clear it.** `open` / `investigating` /
  `mitigated` / `accepted` all mean *"we know, we'll get to it"* — a coherent answer
  for a CVE and an incoherent one for a package that is currently exfiltrating
  tokens. They suppress a CVE; they do **not** suppress a `MAL-` finding.

When the gate reports one:

1. **Remove it or pin away from the affected version**, then regenerate
   `package-lock.json`. Verify: `grep -n '<name>' package-lock.json`.
2. **Assume compromise of anything that installed it.** Rotate registry tokens,
   GHCR tokens, and anything else reachable from a runner or developer shell.
   `ignore-scripts=true` in [`.npmrc`](../../.npmrc) blocks the usual install-time
   execution path, so this is containment — not proof you were unaffected.
3. Record it as `status: fixed` with `closed:` once the lockfile is clean.
4. **Only** for a confirmed false positive: `status: not_affected`, justified in
   `notes`.

Rules and escape hatches are pinned by
[`.github/scripts/test-component-watch-gate.sh`](../../.github/scripts/test-component-watch-gate.sh)
(run in Infrastructure CI → *Shell unit tests*), because every one of them fails
green — a mistake here shows up as a passing build, not a red one.

## Research breaking changes

Before bumping a pinned version, read the upstream changelog / migration notes and
record the result in the ledger `breaking_changes` field. For a
`github_releases`-watched component, start with:

```bash
scripts/component-watch.sh --changelog <id>   # e.g. stalwart — pinned→latest notes, breaking changes flagged, + open-issues/compare links
```

This is **required for tier-0 components** (Stalwart, Postgres, k3s, …) before a
bump — review every release between the pin and latest plus the upstream open
issues for regressions, since these run under active development. Then:

- **Charts** (Traefik, cert-manager, CNPG, Longhorn, sealed-secrets): read the
  chart's `UPGRADING.md` / release notes; watch CRD/values schema changes.
- **k3s**: minor-by-minor only (the version spine + system-upgrade-controller
  enforce sequential hops); check the Kubernetes deprecation guide.
- **PostgreSQL major** (CNPG): follow [PG_MAJOR_UPGRADE.md](PG_MAJOR_UPGRADE.md).
- **Stalwart / webmail / catalog runtimes**: check config-format and data-format
  notes. (The mail archive's `rocksdb-secondary-checkpoint` image had to link the same
  RocksDB as Stalwart. It is dormant while the archive is switched off, and its pin check
  passes without looking; the check re-arms when the archive is switched on — see
  `backend/src/modules/mail-admin/archive-dormant.ts`.)

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

- ~~`postgres-client-backup` PG 17 vs server PG 18~~ — resolved 2026-08-26: the
  legacy pg_dump CronJob (and its image) was retired with the target-activate
  path; CNPG base backups + WAL are the replacement.
- ~~`alpine/k8s` and `busybox` each have two tags in use~~ — resolved: one tag
  each (`alpine/k8s` 1.36.5, `busybox` 1.37), backend init containers included.
- ~~legacy `roundcube-deployment.yaml` with a floating tag~~ — resolved: the file
  is removed; `roundcube/deployment.yaml` (digest-pinned) is the only manifest.
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
