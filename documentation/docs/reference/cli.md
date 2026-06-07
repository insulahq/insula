---
verified: 2026.6.7
---

# platform-ops CLI

`platform-ops` is the operator command-line tool installed on **every cluster
node** at `/usr/local/bin/platform-ops`. It exists for the moments the web
panels can't help you: the platform API is down, you're recovering from a
disaster, or you're driving an upgrade from SSH. It talks to the database and
the Kubernetes API directly, so the privileged commands keep working even when
nothing else does.

It arrives as a self-contained signed binary — installed by `bootstrap.sh`,
kept current by its own `self-upgrade` (signature-verified against the
platform's release key).

## Commands

```text
platform-ops <command> [args]
```

| Command | What it does |
|---|---|
| `version [--json]` | Installed / running / available platform version |
| `cluster status` | Node + control-plane health at a glance |
| `cluster diagnostics` | Best-effort support bundle (nodes, pods, events, flux) |
| `cluster upgrade --version vX.Y.Z+k3sN [--apply]` | Generate k3s upgrade plans; dry-run by default, `--apply` rolls the nodes. Skipping a k3s minor is refused |
| `node cordon\|uncordon <name>` | Node maintenance without the panel |
| `upgrade [--version X.Y.Z] [--apply]` | Plan/apply a **platform** upgrade (re-pins the GitOps source tag) |
| `rollback [--apply] [--restore-data]` | Undo the most recent upgrade. `--restore-data` also reverts storage snapshots — **destructive** |
| `migrations list [--json]` | Platform migrations and their applied status |
| `migrations apply [--dry-run]` | Apply pending platform migrations (DB + cluster) |
| `snapshot capture` | On-demand database base backup |
| `snapshot list` | List object-store backups |
| `dr verify` | Inspect a disaster-recovery bundle — decrypts and prints the manifest, read-only, works with the cluster down |
| `dr restore` | Restore from a DR bundle (selected rows or full recovery) |
| `dr rescue` | Safety snapshots of the system volumes before risky surgery |
| `self-upgrade [--check] [--force] [--version X.Y.Z]` | Update the binary itself (signature-verified, atomic) |
| `host-config status` | Report drift between this host and the cluster's host policy |
| `host-config apply [--dry-run]` | Converge host sysctls, OS packages (additive-only), and host-migration scripts to policy |
| `shell` | Shell with cluster-admin environment (`KUBECONFIG` set) |
| `help` | Show usage |

!!! tip "Which commands work with the platform down?"
    `migrations apply`, `host-config apply`, `cluster upgrade`, `upgrade`,
    `rollback`, `dr restore`, `dr rescue`, and `snapshot capture` are designed
    to function when platform-api is unavailable — they are your recovery
    toolkit. `dr verify` even works with the **whole cluster** down.

See the [updates & releases](../operator/updates-and-releases.md) and
[system backups & DR](../operator/system-backups-dr.md) guides for the
workflows these commands belong to.
