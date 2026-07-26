# ADR-055: `insula` single-binary install + host-footprint branding

**Status:** Proposed (2026-07-26)

Completes the operator-tooling consolidation started in
[ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md) W10c (host-migrations
embedded in the signed CLI) and [R18](../../roadmap/ROADMAP.md#r18--operator-script-consolidation-into-the-platform-ops-cli)
(operator scripts → `platform-ops`). Those left one deliberate exception — the
bootstrap installer stays bash, and it is distributed by cloning the whole
repository. This ADR folds that last piece in without rewriting it, and rebrands
the on-disk footprint to match the product.

## Context

Three rough edges, all legacy accretion rather than deliberate choices, surfaced
while documenting the install flow (2026-07-25/26):

1. **A fresh install requires a full `git clone`.** `bootstrap.sh` is ~9,200
   lines of bash (with `scripts/lib/*`) that sources its sibling libraries by
   relative path (so `curl | bash` is unsupported) and does a one-time *local*
   `kubectl kustomize k8s/overlays/<env>` seed-apply to bring the platform up
   before Flux is reconciling. Strictly only `scripts/` + `k8s/` (1.6 MB, 245
   manifests) + `platform/VERSION` are consumed — never `backend/`, `frontend/`,
   `images/`, or `documentation/`, which ship as prebuilt signed images — but the
   documented step is "clone the repo", which is heavier than needed and leaves
   operators unsure what the clone is for or whether it can be deleted (it can:
   every persistent artifact lands in system paths, not the clone).

2. **The operator binary is named `platform-ops`.** Once bootstrap folds in, this
   binary is the product's single front door (`… bootstrap`, `… cluster upgrade`,
   `… dr restore`). `platform-ops` reads like the internal ops tool it began as,
   not the face of an OSS product; single-binary installers are conventionally
   product-named (k3s, talosctl, flux, cilium).

3. **The host footprint uses generic, *inconsistent* paths.** Five roots across
   two pre-`insula` naming schemes: `/etc/platform` (58 refs — credentials,
   `cosign.pub`), `/var/lib/hosting-platform` (DR secrets bundles + bootstrap
   markers), `/etc/hosting-platform` (firewall/host config), `/var/lib/platform`
   (host-migration markers), `/run/hosting-platform`. "hosting-platform" was the
   repo's original name (it relocated from `k8s-hosting-platform` to `insula`);
   "platform" a later shortening. Generic roots risk collision with unrelated
   software and give an operator inspecting the box no ownership signal;
   inconsistency makes docs, backup-scoping, and cleanup harder than one branded
   root would.

The key enabling fact: `platform-ops` is a Node **single-executable application
(SEA)** that already **embeds shell scripts as assets and runs them via bash** —
that is exactly how host-migrations travel with every self-upgrade
(`host-config/host-migrations.ts`). So folding the bash bootstrap into the binary
is an extension of a proven, shipping mechanism, not a rewrite.

## Decision

### 1. Fold bootstrap into the signed binary — embed, don't rewrite

Add an `insula bootstrap` subcommand that embeds `bootstrap.sh` + `scripts/lib/*`
+ the `k8s/` overlay tree as SEA assets (the same asset mechanism host-migrations
use), extracts them to a `trap`-cleaned tmpdir at runtime, and `exec`s the
existing `bootstrap.sh`. **No host logic is ported to TypeScript** — the bash
travels inside the binary and runs unchanged, so the OS-matrix-hardened install
path is preserved verbatim. The local kustomize seed-apply reads the extracted
tree; nothing changes in the seed-apply logic itself.

The operator flow becomes a single signed artifact, no clone:

```bash
curl -fsSLO https://github.com/insulahq/insula/releases/download/<ver>/insula-linux-amd64
chmod +x insula-linux-amd64
./insula-linux-amd64 bootstrap --domain hosting.example.com --acme-email ops@example.com
```

*Why this is strictly better:* the installer is now **cosign-signed and
verifiable** (today `bootstrap.sh` is unsigned repo content trusted implicitly);
installer + manifests + migrations are **version-locked and signed together**
(identical to the self-upgrade path); and the "`curl | bash` unsupported"
limitation disappears (it existed *only* because of the sibling-lib relative
paths, now embedded).

The **repo path stays working for development and CI** — `./scripts/bootstrap.sh`
from a checkout uses the filesystem-dir fallback the SEA already supports
(`… embedded assets — or a filesystem dir in dev`). Operators get the binary;
developers keep the source.

### 2. Rename the user-facing artifact to `insula`; keep the internal module

Rename the **artifact and its reference points** — release asset
(`insula-linux-*`), install path (`/usr/local/bin/insula`, one knob via the
`PLATFORM_OPS_BIN` default), the two systemd `ExecStart` lines (already
`${bin}`-parameterized, so they follow the default), docs, and command examples.
**Do not rename the internal module** (`backend/src/cli/platform-ops/`, ~43
files) — nobody types the module path, and renaming it is pure refactor churn
with zero user benefit. A one-line header comment records that the `cmd`
directory name differs from the shipped binary, a common and unremarkable split.

### 3. Consolidate + brand the host footprint via symlinks, not moves

Consolidate the five roots into one branded pair — **`/var/lib/insula`** +
**`/etc/insula`** (+ `/run/insula`) — using **compatibility symlinks
(old → new)**, not `mv`. The paths hold *state* (migration markers, DR bundles,
the cosign trust anchor), so a physical move is a data migration with real
failure modes; a symlink lets both old baked-in references and new code resolve
to the same inode with zero data movement and zero re-run risk.

The host-migration marker root is the sharp edge and the reason symlinks are
mandatory, not merely convenient: markers live at
`/var/lib/platform/host-migrations/<ver>/<name>.done`
(`host-config/index.ts:HOST_MIGRATION_MARKER_ROOT`). Physically moving that
directory would make every node see zero markers at the new path and **re-run all
host-migrations** — and the migration that moved them would itself be
marker-tracked, a chicken-and-egg. Keeping `/var/lib/platform` as a symlink to
`/var/lib/insula` means the constant resolves identically whichever name is used,
and no marker is ever "missing".

### 4. Deliver the rename + rebrand to existing clusters via one host-migration

Fresh installs get the new names and paths from bootstrap directly. Existing
clusters get them the way every host-layer change reaches them
([ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md) W10c) — a single new
migration `platform/host-migrations/<transition-ver>/NNNN-rebrand-to-insula.sh`
that:

- installs `/usr/local/bin/insula` (idempotent; the binary is already on the node
  after self-upgrade — this is a re-point + symlink step),
- creates the branded roots and `old → new` symlinks
  (`/var/lib/platform` → `/var/lib/insula`, `/etc/platform` → `/etc/insula`,
  `/var/lib/hosting-platform`/`/etc/hosting-platform` → the branded roots),
- re-points the two systemd units (self-upgrade timer + host-config converger),
  whose `ExecStart` has the **literal** old path baked in on installed nodes
  because `${bin}` was expanded at install time,
- leaves `/usr/local/bin/platform-ops` → `insula` as a compatibility symlink.

The transition **release** ships **both** asset names (`insula-linux-*` and
`platform-ops-linux-*`) so a node whose *old* binary runs the self-upgrade timer
can still fetch the release that lays down the new name — without this, existing
nodes strand (the same failure class as the missing-`cosign.pub` worker incident,
2026-07-25). Compatibility symlinks + dual asset names stay for one further
release, then drop once no reference resolves the old names.

**Self-reference note:** the host-config converger that *runs* the rebrand
migration is re-pointing its own `ExecStart`. This is safe — the symlink keeps
the in-flight invocation valid and systemd re-reads the unit on the next timer
fire — but the migration must carry an explicit comment so a future reader does
not mistake it for a foot-gun.

## Consequences

**Positive**

- One signed, verifiable artifact to install; no repo clone; `curl`-and-run is
  safe. Answers "can I delete the clone" (there is no clone) and "why the whole
  repo" (there is no whole repo).
- The installer joins the same cosign-verified supply chain as upgrades.
- Product-named front door (`insula …`) for an OSS project actively courting
  users.
- Five inconsistent host roots collapse to one branded pair — cleaner docs,
  backup-scoping, and cleanup.
- Done now, pre-production, while the installed base is a single staging cluster —
  the cheapest this rename/rebrand will ever be.

**Costs / risks (all bounded)**

- SEA build stages a few more assets (~1.7 MB) — the release workflow already
  builds the SEA; incremental.
- The transition release must ship dual asset names + symlinks; drop them a
  release later. Missing this strands existing nodes' self-upgrade.
- The bash still shells out to apt/dnf/the k3s installer/nftables — unchanged and
  correct; that work stays shell.
- Host-migration markers are **name-independent**, so the binary rename cannot
  re-trigger migrations; the *path* rebrand preserves that only because it uses
  symlinks, not moves — this invariant is load-bearing and CI-guardable.

## Out of scope / explicitly not doing

- **Not** porting host bash to TypeScript (reaffirms the R18 / ADR-045 line —
  "stays bash" is about the *logic*, not the *distribution*; the bash rides in the
  signed binary the way host-migrations already do).
- **Not** renaming the internal `platform-ops` module or its ~43 source files.
- **Not** physically moving any stateful directory — symlinks only, until a much
  later cleanup once no old reference remains.

## References

- [ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md) — versioning,
  self-upgrade, host-migrations (W10c).
- [ADR-053](ADR-053-gitops-restructure-development-upstream.md) — release/branch
  model the signed-asset fetch rides on.
- [R18](../../roadmap/ROADMAP.md#r18--operator-script-consolidation-into-the-platform-ops-cli) —
  operator-script consolidation (drew the keep-bootstrap-as-bash line this ADR
  refines).
- [R23](../../roadmap/ROADMAP.md#r23--insula-single-binary-install--branding) —
  the tracked work item.
