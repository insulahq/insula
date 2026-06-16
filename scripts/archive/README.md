# scripts/archive — retired one-shot scripts

One-time migrations / spikes that have **already run** and are not part of any
durable operator or CI flow. Kept here (rather than deleted) so the
host-migration registry (ADR-045 W10c) and future archaeology can reference them
without `git log` spelunking. They are **not** wired into bootstrap, CI, or the
backend — moving one back to `scripts/` to re-run it is a deliberate act.

Retired under [ROADMAP R18](../../docs/roadmap/PLATFORM_OPS_CLI_CONSOLIDATION.md)
§7.2 (2026-06-14). Only scripts with **no remaining references** were moved; the
many migration/backfill scripts still referenced by bootstrap, CI, kustomize
overlays, or backend code stay in `scripts/`.

| Script | What it was |
|---|---|
| `migrate-cluster-to-substituteFrom.sh` | One-shot: wired existing clusters' overlays onto `${DOMAIN}` + Flux `postBuild.substituteFrom` (the domain-pinning elimination). |
| `migrate-stalwart-default-hostname.sh` | One-shot: migrated Stalwart to the default `mail.<apex>` hostname convention. |
| `migrate-stalwart-tls-bootstrap.sh` | One-shot: migrated Stalwart TLS onto the ACME-via-Traefik bootstrap path. |
| `storage-snapshot-backfill.sh` | Phase-7 one-shot backfill of storage-snapshot rows for pre-existing PVCs. |
| `spike-flux-repin-validate.sh` | Spike (ADR-045 W16/PR-18): validated the Flux re-pin/rollback approach (locked decision #14). |
| `spike-restic-jmap.sh` | Phase-0 spike: validated the restic primitive against the platform's mail/JMAP data. |
| `integration-snapshot-streaming.sh` | Phase-4 E2E for the **off-site tar/streaming snapshot + rollback** path (`POST /storage/snapshot`, `POST /storage/rollback`). Retired 2026-06-16 when the tar path was removed — tenant PVC snapshots are now on-server Longhorn CSI (`/tenants/:id/snapshots`, covered by `integration-backups-ui.sh` B4) and off-site backups are restic tenant-bundles (`integration-tenant-bundles-files-browse-restore-e2e.sh`; pre-resize/pre-archive restic in `integration-lifecycle-e2e.sh`). |
