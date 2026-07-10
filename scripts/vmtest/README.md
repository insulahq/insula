# `scripts/vmtest/` — ephemeral VM integration-test tier

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

| `VMTEST_DRIVER` | Do this |
|---|---|
| `libvirt-sock` | bind-mount the host's `/var/run/libvirt/libvirt-sock` into this env; `apt install libvirt-clients qemu-utils genisoimage`; bind-mount `VMTEST_POOL_DIR` at the same path both sides |
| `ssh-host` | put an SSH key to the Unraid host at `VMTEST_HOST_SSH_KEY`; ensure `virsh`/`qemu-img`/`docker` exist on the host |

Then:

```bash
cp scripts/vmtest/config.example.env scripts/vmtest/config.env
$EDITOR scripts/vmtest/config.env          # set VMTEST_DRIVER + enablement + apex + OS

./scripts/vmtest/os-images.sh list         # show the supported-OS matrix
./scripts/vmtest/os-images.sh debian-13    # cache one OS golden (or: all)
./scripts/vmtest/run.sh                     # one throw-away run on VMTEST_OS
./scripts/vmtest/run.sh --os ubuntu-24.04   # …on a specific OS
./scripts/vmtest/run-matrix.sh              # sweep VMTEST_OS_MATRIX, one run per OS
```

## Files

| File | Role |
|---|---|
| `config.example.env` | tunables (driver, OS, matrix, node count, ACME tier, backup) |
| `lib/os-registry.sh` | supported-OS → stock cloud-image map (Debian/Ubuntu/Rocky/Alma/CentOS/AL2023) |
| `lib/driver.sh` | `libvirt-sock`/`ssh-host` backends — domains, net, images, service containers |
| `lib/waitfor.sh` | bounded ssh / cloud-init / k3s-Ready waits (fail-fast) |
| `os-images.sh` | fetch + cache the per-OS golden cloud image (`list` \| `<os>` \| `all`) |
| `net-services.sh` | per-run NAT net + PowerDNS + Pebble (ACME) + MinIO |
| `spawn-cluster.sh` | overlay-clone N VMs (per-OS golden), `bootstrap.sh --remote`, wait Ready |
| `run.sh` | one run (`--os <id>` optional); calls `integration-all.sh` unchanged |
| `run-matrix.sh` | multi-OS compatibility sweep — one full run per OS + summary table |
| `teardown.sh` | throw the whole run away (trap-safe, idempotent) |

## Guarantees / discipline

- **No hardcoded pins** — `bootstrap.sh` runs verbatim inside the VMs; its version
  pins are the single source of truth. Zero local↔staging drift by construction.
- **Trap-safe teardown** — `run.sh` tears down on EXIT (set `VMTEST_KEEP_ON_FAIL=1`
  to keep a failed run for debugging). Golden image is cached across runs.
- **Reuses the real harness** — `integration-all.sh` is called unchanged; the VM
  tier only provisions and sets the env contract. The baseline gate reporting
  *no drift* on a fresh cluster is the pass condition; drift = a real bootstrap bug.
- **Never real production LE** — Pebble (default) or LE-staging only.
