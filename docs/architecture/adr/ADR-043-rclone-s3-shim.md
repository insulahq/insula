# ADR-043: `rclone serve s3` shim — universal backup mediator

**Status**: **ACCEPTED-EXTENDED 2026-05-20**, **NFS-AMENDED 2026-05-25** — the shim is adopted as the universal mediator for ALL platform backups, not just postgres + etcd. See [BACKUP_ARCHITECTURE_RFC §13a](../../history/04-deployment/BACKUP_ARCHITECTURE_RFC.md) for topology.
**Original decision (DEFERRED)**: 2026-05-19
**Withdrawn (incorrectly)**: 2026-05-19 — based on a false assertion that `cnpg-plugin-pgbackrest` exists
**Accepted + extended**: 2026-05-20 (corrects the round-5 mistake)
**Postscript (NFS dropped)**: 2026-05-25 — see "Postscript: NFS support dropped" section below

## Postscript: NFS support dropped (2026-05-25)

**TL;DR**: The `nfs` storage_type was removed from the API contract, DB enum, shim renderer, and bench fixtures. The four code paths now refuse NFS at every layer.

**Why** — when R-X19 (2026-05-21) made the shim DaemonSet fully unprivileged (`runAsUser:65534, drop:[ALL]`, no `CAP_SYS_ADMIN`, no `/dev/fuse`), it eliminated the kernel-mount path that the original ADR designed for NFS. The four downstream consequences:

1. **rclone has no NFS *client* backend.** rclone's `nfs` is a server-side feature; it cannot consume an NFS export.
2. **The kernel-mount alternative requires `CAP_SYS_ADMIN`.** Re-introducing that capability undoes the R-X19 hardening.
3. **The `csi-driver-nfs` workaround was never wired.** It would have provisioned a PVC from the export and let the shim mount it as `type=local`, but the platform-api never exposed `local` as a storage_type and the operator UX cost of "deploy a separate CSI driver to support one backend type" was not justified by operator demand.
4. **The half-shipped state was actively misleading.** Migration 0015 (added 2026-05-22) created the schema, but the API rejected NFS at create-time and the renderer hard-rejected NFS at render-time. Operators who inserted rows via SQL got opaque async `STATE_ERROR` after binding.

**What changed (2026-05-25)** — see `chore(backup-rclone-shim): drop NFS support` commit:

- Migration 0027 drops the four `nfs_*` columns, the `backup_configurations_nfs_required` CHECK, and narrows the `storage_type` enum to `(ssh, s3, cifs)`. (Number 0026 was already taken by `drop_pg_dump_schedules`.)
- `packages/api-contracts/src/backup-rclone-shim.ts` narrows the `targetStorageType` zod enum.
- `backend/src/modules/backup-rclone-shim/` removes every `case 'nfs':` branch (renderer + service + status + apply-assignment).
- `backend/src/modules/backup-config/longhorn-reconciler.ts` narrows `clearBackupTarget`'s `kind` parameter.
- `k8s/overlays/staging/nfs-test-server/` is deleted (the bench harness no longer has an NFS upstream to target).
- CI guard `scripts/ci-backup-rclone-shim-check.sh` invariant 17 inverted: re-introducing `nfs` anywhere — manifests, contract enum, schema enum — fails the build.

**Operator impact**: zero rows on either staging or testing carried `storage_type='nfs'` at the time of removal (the migration's `DO $$ … RAISE EXCEPTION` guard refuses to run otherwise). Operators with NFS backup destinations can:

- Expose the NFS export through an SMB server (most Linux NAS distros bundle Samba) and add it as a CIFS target, OR
- Front it with an SFTP daemon and add it as an SSH target, OR
- Replicate it into an S3-compatible object store (MinIO, etc.) and add it as an S3 target.

If a customer segment with hard NFS-only requirements emerges later, the cleanest re-introduction path is the `csi-driver-nfs` route: add a new `local` storage_type that consumes a pre-bound PVC, document the operator's CSI install step, and keep the shim itself unprivileged. The deprecated design tables below remain as historical context.

---



## Why the 2026-05-19 withdrawal was wrong

The withdrawal claimed `cnpg-plugin-pgbackrest` is an official CNPG sub-project supporting SFTP. **Verified incorrect**: `gh search repos cloudnative-pg pgbackrest` returns only `cloudnative-pg/plugin-barman-cloud`, which supports only S3 / Azure Blob / GCS (per `BarmanObjectStoreConfiguration` source — comment: *"Barman against an S3-compatible object storage"*). The pgBackRest plugin does not exist. The 2026-05-19 docs commit (`6d85c512` on main) was based on this mistake. R-X0 corrects the record and extends the shim's scope to universal mediation.

## Why the shim is now the *universal* mediator (not just SYSTEM)

The original ADR scoped the shim to postgres + etcd (the only S3-locked callers). The round-6 design extends it to ALL backup callers (restic × N, rclone-push × N) for these reasons:

1. **One operational component** instead of N caller-specific backend configs.
2. **One target switch propagates everywhere** — change SYSTEM's target, postgres + etcd + secrets all follow.
3. **Per-class buckets preserve isolation** — `s3://system`, `s3://tenant`, `s3://mail`, plus `-raw` variants for self-encrypting callers (restic, age).
4. **One platform-wide `BACKUP_TARGET_KEY`** simplifies DR: restore the secrets bundle, all backups become readable. (See RFC §13b.)
5. **Empirical eval validated** the shim's throughput + memory + stability profile at SYSTEM scale; extending to TENANT + MAIL traffic is bounded by upstream bandwidth, not the shim.

## Supported backend types (operator-selectable per class)

> **2026-05-25 amendment**: NFS removed. See the postscript at the top of this ADR. The row is left in the table below as historical context.

| Backend | rclone module | Pod-side requirements | Notes |
|---|---|---|---|
| **S3 / S3-compatible** | `s3` | none | Default for cost-aware operators (AWS S3, Hetzner Object Storage, Backblaze B2, MinIO, etc.) |
| **SFTP** | `sftp` | none | Hetzner Storage Box, self-hosted; password or SSH-key auth |
| **CIFS / SMB** | `smb` (native rclone client, since R-X19) | none | Hetzner Storage Box CIFS, Windows shares |
| **~~NFS~~** | ~~wrap `local` backend; share kernel-mounted via k8s built-in `volumes[].nfs`~~ | ~~none for NFSv3; `csi.nfs.k8s.io` for NFSv4 features~~ | **REMOVED 2026-05-25 (mig 0026) — see postscript** |
| **WebDAV** | `webdav` | none | Optional later add — handled by rclone with no platform-api changes |
| **GCS / Azure / Box / Dropbox / B2 / etc.** | rclone native | none | Optional later add |

**Posix-mount backends (CIFS, NFS)** — both kernel-mount the share via the shim Pod's `volumes[]` field, mounted at `/mnt/backup-<class>-<storage>`. The rclone config for these targets uses `type = local, copy_links = false, no_check_updated = true, path = /mnt/backup-<class>-<storage>`. The crypt + passthrough buckets layer on top of that local backend exactly like for S3.

**Why kernel-mount instead of rclone NFS client**: rclone has no NFS *client* backend (its `nfs` is a server-side feature). Kernel NFS mount via the Pod's `volumes[].nfs` field is the standard k8s pattern.

**Why kernel-mount for CIFS instead of rclone's smb client**: rclone DOES have a `smb` client backend. Either works, but consolidating on kernel-mount unifies the operational pattern (one POSIX directory + `type = local` recipe) for both CIFS and NFS, simplifying the renderer and observability. We can flip to rclone-native SMB later — platform-api abstracts the difference.

## Context

[BACKUP_ARCHITECTURE_RFC](../../history/04-deployment/BACKUP_ARCHITECTURE_RFC.md) §7 documents the hard constraint that some backup mechanisms only support S3-compatible APIs:

| Mechanism              | S3 | SFTP | CIFS | NFS |
| ---------------------- | -- | ---- | ---- | --- |
| barman-cloud (CNPG)    | ✅ | ❌   | ❌   | ❌  |
| k3s `--etcd-s3`        | ✅ | ❌   | ❌   | ❌  |
| Longhorn native backup | ✅ | ❌   | ❌   | ✅  |
| restic                 | ✅ | ✅   | ✅   | ✅  |
| rclone (generic)       | ✅ | ✅   | ✅   | ✅  |

Effect: SYSTEM class can only be assigned an S3-compatible target. Operators with only SFTP (Hetzner Storage Box) or CIFS (self-hosted) targets either need a separate S3 setup OR can't back up postgres + etcd at all.

`rclone serve s3` exposes any rclone backend (SFTP, CIFS, local fs, etc.) as an S3-compatible HTTP API. This unlocks SYSTEM coverage on non-S3 backends.

## Why we're not shipping it in v1

1. **Operator economics in target band**. Hetzner Storage Box (the de facto target for cost-conscious operators) now offers an S3 API on newer accounts. Most operators on the platform's price band already have S3.
2. **New long-running service**. rclone-serve-s3 becomes a critical-path component: if it dies, every SYSTEM backup fails. Needs HA (2-replica Deployment), TLS termination, secrets, monitoring, version pinning.
3. **v1 scope**. The current RFC is already 8-9 working days. Adding rclone-serve-s3 pushes it past 10. v1's "SYSTEM needs S3" constraint is a clear, documented limitation rather than a blocker.
4. **Performance overhead**. Every backup byte transits an extra HTTP hop + rclone process. Acceptable for low-frequency backups, but adds latency.

## Decision

Defer. The Path A++ design in the main RFC (graceful per-subsystem degradation badges) addresses the same operator pain — operators with only SFTP/CIFS see honest "postgres + etcd: needs S3" status on the SYSTEM class card and can run with partial coverage. Adding a new long-running service to "fix" this is over-engineering until a real operator hits the wall.

Document the design here so it's not lost.

## When we'd revisit

- Operator on a self-hosted CIFS/SFTP-only setup asks for full SYSTEM coverage
- Customer in an air-gapped environment with no S3 access
- The platform onboards a customer segment where SFTP/CIFS is the standard (e.g. some EU government clouds)

## Design (for whoever picks this up)

### Architecture

```
                ┌─────────────────────────────────────┐
                │  platform namespace                  │
                │                                       │
  CNPG postgres ─→─┐                                   │
  k3s etcd ──────→─┤   rclone-serve-s3 Deployment      │
  Longhorn ─────→─┘   (2 replicas, ClusterIP service)  │──→  operator's actual backend
                │   ↑                                  │     (SFTP / CIFS / NFS)
                │   │                                  │
                │   └─── reads creds from              │
                │        Secret(rclone-shim-config)    │
                └─────────────────────────────────────┘
```

### Components

1. **`Deployment` `rclone-serve-s3`** in `platform` namespace:
   - 2 replicas, anti-affinity across nodes
   - Image: `rclone/rclone` pinned by digest, command: `rclone serve s3 --addr :9000 --vfs-cache-mode writes`
   - Backend config mounted from `Secret`: `[upstream]` block pointing at SFTP/CIFS/whatever
   - Access-key / secret-key generated at install time, stored in `Secret rclone-shim-creds`
   - PVC for vfs-cache (writes buffer): `longhorn-ha`, sized 10% of total backup volume (e.g. 5 GiB default)
2. **`Service` `rclone-serve-s3.platform.svc.cluster.local:9000`** (ClusterIP only — never exposed outside cluster)
3. **`Certificate`** via cert-manager Issuer for in-cluster TLS (cluster-issuer signing for `*.platform.svc`)
4. **New `backup_configurations.storageType` value**: `s3_via_rclone_shim`
   - Stores both the shim endpoint AND the backing storage credentials
   - When operator creates this kind of target via UI, platform-api updates the `Secret rclone-shim-config` with a new backend block + restarts the Deployment
5. **UI integration**: target picker shows "S3 (via rclone shim — backed by `<your SFTP host>`)" entries alongside native S3 targets

### Operator UX

Configure target → UI shows:
- Target type: `S3 (via rclone shim)`
- Backing storage type: SFTP / CIFS / NFS / local
- Backing storage credentials (operator inputs once)
- Generated S3 endpoint: `http://rclone-serve-s3.platform.svc.cluster.local:9000` (auto)
- Generated access-key/secret-key (auto, stored in cluster Secret)

barman-cloud, k3s etcd, Longhorn native backup all use the auto-generated S3 endpoint + creds. Operator never sees the internal shim plumbing.

### Operational concerns

- **HA**: 2 replicas behind ClusterIP. Active-active is fine for read; for write, rclone's vfs-cache mode prevents concurrent-write races (writes serialise through the cache). Single-active-writer pattern via leader election is overkill for our load.
- **Failure modes**: shim Pods crash → backups fail → platform-api admin event → operator manually investigates. No automatic failover to "skip the shim" because the upstream isn't S3.
- **Version pinning**: pin rclone by digest in Flux. Major-version upgrades require operator opt-in (UI button + soak window).
- **TLS rotation**: cert-manager auto-rotates. Re-issue happens transparently to the consumers (in-cluster only, no public exposure).
- **Monitoring**: emit Prometheus metrics for rclone process (already supported via `--metrics-addr`). Alert on `up{job="rclone-serve-s3"} == 0` for >5 min.

### Estimated effort

12-16h:
- 2h: Deployment + Service + Secret + Issuer manifests
- 3h: Platform-api integration (target CRUD + Secret materialisation)
- 3h: UI changes (target picker, target type metadata)
- 2h: Bootstrap.sh integration (cert auto-creation, leader-elect plumbing)
- 2h: E2E test (backup roundtrip via shim against a fake SFTP target in DinD)
- 2-4h: Operator runbook + ADR finalisation

### What's NOT in scope

- Multi-backend chaining (use SFTP for cold, S3 for hot — not solving for that)
- rclone-serve-s3 across clusters (single per-cluster instance only)
- Public S3 endpoint exposure (always ClusterIP — no need to expose outside)

## Trade-offs vs alternatives

| Approach | Lift | Operational complexity | Operator UX |
|---|---|---|---|
| **rclone-serve-s3** (this ADR) | One new service; bidirectional uplift | HA + TLS + version mgmt | Single target type works for everything |
| **Path A++ degradation badges (v1)** | Tiny — just UI status logic | Zero | Operator picks SFTP for SYSTEM, sees postgres + etcd as "needs S3" badges; they know what's covered and what's not |
| Document constraint, push operator to S3 | Zero engineering | Zero | Operator must procure S3 — most operators already have it; friction is low |
| Per-mechanism S3 emulators (postgres → MinIO Gateway, etcd → its own…) | Many small services | Many small services to operate | Operator sees N target types — worse than the shim |
| Drop barman/etcd-s3 mechanisms entirely | Re-implement postgres + etcd backup via rclone | Loss of upstream-supported mechanisms | Backup tooling drifts from upstream best-practice |

**Path A++ wins for v1.** rclone-serve-s3 is the cleanest path when the trigger fires (real SFTP-only operator who explicitly demands postgres coverage), not before.
