# backup-rclone

Universal backup mediator image used by the platform's `backup-rclone-shim`
DaemonSet and all backup CronJob clients. See
[BACKUP_ARCHITECTURE_RFC §13a](../../docs/history/04-deployment/BACKUP_ARCHITECTURE_RFC.md)
for the architecture and [ADR-043](../../docs/07-reference/ADR-043-rclone-s3-shim.md)
for the design decision.

## Two roles, one image

| Role | How invoked | Notes |
|---|---|---|
| **Shim DaemonSet** | `rclone serve s3 --config /etc/rclone/rclone.conf --addr :443 …` | One pod per node; exposes per-class buckets to local-node clients only via `Service.internalTrafficPolicy: Local` |
| **CronJob clients** | `rclone copy --s3-endpoint=https://backup-rclone-shim.platform.svc:443 <src> <dst>` | etcd-snap-via-shim CronJob; can also be used by ad-hoc admin debugging Jobs |

Both roles use the SAME image. Differentiation is via the Pod spec
(volumes, env, command).

## Contents

- `tini` PID-1 signal handler
- `rclone v1.68.2` — SHA256-verified at build time against the
  upstream `SHA256SUMS` (build aborts on mismatch); pinned ARG values
  in the Dockerfile
- `zstd` — compression for etcd snapshots + tenant-bundle artefacts
- `openssh-client` — rclone's `sftp` backend uses ssh + known_hosts
- `ca-certificates`, `tzdata`, `procps` — TLS + liveness probes

Size: ~110 MiB uncompressed → ~35 MiB compressed (multi-arch). rclone
itself is ~58 MiB uncompressed (Go static binary with all backends);
the rest is alpine libc + ca-certificates + openssh.

Intentionally NOT included: `mount.cifs`, `mount.nfs` — kernel mounts
are performed by the host's CSI driver and kubelet, NOT this container.
Including them would widen the attack surface (some distros ship
`mount.cifs` setuid-root).

Non-root by default (uid 65534 / nobody). DaemonSet manifest overrides
where the host's k3s snapshot dir needs root-readable access via the
`etcd-snap-via-shim` CronJob role.

## Building locally

```bash
cd images/backup-rclone
docker build -t backup-rclone:dev .
docker run --rm backup-rclone:dev /usr/local/bin/rclone version
```

## CI / publishing

`.github/workflows/ci-backup-rclone.yml` builds multi-arch
(linux/amd64 + linux/arm64), pushes to
`ghcr.io/insulahq/insula/backup-rclone:<git-sha>`,
and produces an SBOM + cosign signature.

Flux pins by digest in
`k8s/base/backup-rclone-shim/daemonset.yaml`. The R-X14 phase benchmarks
the production-config image against the round-5 eval baseline to confirm
≥80% of throughput.

## Updating rclone version

1. Pick the new version from https://github.com/rclone/rclone/releases
2. Get the SHA256 from https://downloads.rclone.org/v\<version\>/SHA256SUMS
3. Update `RCLONE_VERSION`, `RCLONE_SHA256_AMD64`, `RCLONE_SHA256_ARM64`
   in the Dockerfile
4. Re-build locally + smoke test the shim against local DinD
5. Re-run `./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh` to
   confirm no perf regression
6. Open a PR — CI build pushes the new image with a new tag/digest
7. Flux digest pin in `k8s/base/backup-rclone-shim/daemonset.yaml`
   updated in the same PR (or a follow-up)
