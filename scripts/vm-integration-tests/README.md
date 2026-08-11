# `scripts/vm-integration-tests/` — ephemeral VM integration-test tier

Throw-away KVM cluster per run, `bootstrap.sh` verbatim, then the full
`integration-all.sh`. Design: [`docs/development/EPHEMERAL_VM_INTEGRATION_TESTING.md`](../../docs/development/EPHEMERAL_VM_INTEGRATION_TESTING.md).

> **Status: scaffolded, NOT wired to live orchestration.** These scripts are
> written for a real run but are **untested until an operator enables a driver**
> — this sandbox has no `/dev/kvm`. KVM always runs on the Unraid *host*; this env
> is only the libvirt *client*.

## Why a whole VM tier

~half of the 73 `integration-*.sh` suites are host/kernel-bound (SSH into nodes,
Longhorn block devices, `bootstrap.sh`, host-migrations, nftables firewall,
node-terminal `nsenter`, multi-node drain). DinD can't provide those faithfully.
And a **fresh VM per run** structurally eliminates the cross-run state leak that
caused our "passes standalone, fails in the full run" flakiness.

## Enablement (pick one, one-time)

`ssh-host` is **recommended** (auditable, revocable, command-restrictable; see the design
doc's host-access notes). Either way the rig needs **only libvirt on the host — no host
Docker**: the DNS/ACME/S3 services run in a throw-away services VM's own Docker.

| `VMTEST_DRIVER` | Do this |
|---|---|
| `ssh-host` *(recommended)* | put an SSH key to the Unraid host at `VMTEST_HOST_SSH_KEY`; ensure `virsh`/`qemu-img` exist on the host (no host Docker needed) |
| `libvirt-sock` | bind-mount the host's `/var/run/libvirt/libvirt-sock` into this env; `apt install libvirt-clients qemu-utils genisoimage`; bind-mount the host storage dirs (`VMTEST_IMAGE_CACHE_DIR` + `VMTEST_DISK_DIR`) at the same path both sides |

Then:

```bash
cp scripts/vm-integration-tests/config.example.env scripts/vm-integration-tests/config.env
$EDITOR scripts/vm-integration-tests/config.env          # set VMTEST_DRIVER + enablement + apex + OS

./scripts/vm-integration-tests/os-images.sh list         # show the supported-OS matrix
./scripts/vm-integration-tests/os-images.sh all          # pre-warm all pool goldens (optional)
./scripts/vm-integration-tests/run.sh                     # one run: RANDOM OS per node (heterogeneous cluster)
./scripts/vm-integration-tests/run.sh --os debian-13      # pin every node to one OS (debug an OS-specific bug)
./scripts/vm-integration-tests/run.sh --seed 12345        # replay a past run's exact OS assignment
```

## Two tiers

```bash
./run.sh                                    # branch tier (default)
VMTEST_TIER=release /path/to/rel/scripts/vm-integration-tests/run.sh   # release tier
```

**branch** — installs from the working tree. Fast, pre-merge, catches installer
regressions before they can be released. Everything runs *except* the
release-machinery assertion, for a structural reason rather than a strictness
one: `integration-all` resolves the "deployed release" from the platform-api
image **tag** and feeds it to `self-upgrade --version=`. On `development`,
build-deploy tags images with a timestamp (`20260803150616-0de280c`), so a
version parser is handed an image tag and correctly refuses it. No binary,
released or locally built, can converge that — host-migrations are keyed by
CalVer release directories. The branch tier therefore declines to assert
something it cannot express, and **says so on every run** rather than passing
quietly.

**release** — installs from a **release-tag checkout**, exactly what an operator
downloads: `platform/VERSION` equals the tag, the signed binary resolves, image
tags *are* the version, and host-config converge becomes a real test of the
machinery that upgrades production hosts.

```bash
git worktree add /tmp/rel v2026.8.1
VMTEST_TIER=release /tmp/rel/scripts/vm-integration-tests/run.sh
```

The tier is a claim about what is under test, so it is **verified, not trusted**:
a `release` run from an untagged tree, or one whose tag and `platform/VERSION`
disagree, is refused. A release run that silently exercised the branch would be
worse than no release run at all.

Run the branch tier on every installer-touching change; the release tier after
every cut.

## The OS target

Every run uses **one pinned OS: Debian 13.6**, itself pinned to a dated cloud-image
build rather than a floating `latest`. Before bootstrap starts, the harness asserts
the booted guest actually reports `13.6` and aborts if it doesn't — so an upstream
image swap can never quietly change what the suite runs on.

Runs used to draw a **random OS per node** from the whole supported matrix. That was
dropped deliberately: it made every red run ambiguous (the OS draw had to be triaged
before a failure could be attributed to a change) and multiplied wall-clock and host
RAM along a dimension most defects don't live on. The matrix is still one command away
when a change genuinely touches OS dispatch or host packages:

```bash
./scripts/vm-integration-tests/run.sh --os rocky-9         # one specific OS
VMTEST_OS_POOL="$(source scripts/vm-integration-tests/lib/os-registry.sh; os_pool_all)" \
  ./scripts/vm-integration-tests/run.sh                    # sweep all 8
```

All eight supported OSes remain in the registry, and the platform's Tier-1/Tier-2
support claim is unchanged.

## Config

Everything lives in `config.env` (copied from `config.example.env`) — VM specs
(`VMTEST_VCPU`/`RAM_MB`/`DISK_GB`, and `VMTEST_SVC_*` for the services VM) and all
storage paths. Two path classes:

- **HOST** (qemu reads): `VMTEST_IMAGE_CACHE_DIR` (cached OS goldens, persistent) and
  `VMTEST_DISK_DIR` (per-run VM disk overlays + seed ISOs, ephemeral). Both default
  under `VMTEST_POOL_DIR` but are independently overridable — e.g. cache OS images on
  bulk storage, put churny VM disks on SSD.
- **LOCAL** (this env): `VMTEST_TMP_DIR` (ssh keys, cloud-init) and `VMTEST_REPORT_DIR`.

## Files

| File | Role |
|---|---|
| `config.example.env` | tunables (driver, OS, matrix, node count, ACME tier, backup) |
| `lib/os-registry.sh` | supported-OS → stock cloud-image map (Debian/Ubuntu/Rocky/Alma/CentOS/AL2023) |
| `lib/driver.sh` | `libvirt-sock`/`ssh-host` backends — domains, net, images, service containers |
| `lib/waitfor.sh` | bounded ssh / cloud-init / k3s-Ready waits (fail-fast) |
| `os-images.sh` | fetch + cache golden cloud images (`list` \| `<os>` \| `all`=pool) |
| `net-services.sh` | per-run NAT net + a throw-away **services VM** whose own Docker runs PowerDNS/Pebble/MinIO (no host Docker) |
| `spawn-cluster.sh` | draw a **random OS per node**, overlay-clone, `bootstrap.sh --remote`, wait Ready |
| `run.sh` | one run (random-OS cluster; `--os`/`--seed` to pin/replay); calls `integration-all.sh` unchanged |
| `teardown.sh` | throw the whole run away (trap-safe, idempotent) |

## Guarantees / discipline

- **No hardcoded pins** — `bootstrap.sh` runs verbatim inside the VMs; its version
  pins are the single source of truth. Zero local↔staging drift by construction.
- **Retained by default** — `run.sh` KEEPS the cluster on EXIT (`VMTEST_KEEP=1`, the
  default) so follow-up questions don't cost another ~4h run. The next run reclaims
  older runs automatically, so only the latest is retained; `VMTEST_KEEP_ALL=1` opts
  out of that. Reclaim explicitly with `teardown.sh <run-id>`. CI should set
  `VMTEST_KEEP=0`.
- **Trap-safe teardown** — with `VMTEST_KEEP=0`, `run.sh` tears down on EXIT (set `VMTEST_KEEP_ON_FAIL=1`
  to keep a failed run for debugging). Golden image is cached across runs.
- **Reuses the real harness** — `integration-all.sh` is called unchanged; the VM
  tier only provisions and sets the env contract. The baseline gate reporting
  *no drift* on a fresh cluster is the pass condition; drift = a real bootstrap bug.
- **Never real production LE** — Pebble (default) or LE-staging only.
