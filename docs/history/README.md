# Historical Documentation — FROZEN

> **Status:** Frozen as of 2026-06-07. Nothing in this directory is maintained.
> **Deletion policy:** This entire directory will be **deleted once the user-manual
> website ships** (roadmap item R14). It is kept until then because several
> planning-era requirement documents are source material for the manual.
> Git history preserves everything after deletion.

## What lives here

Planning-era artifacts from the 2026 Q1/Q2 build-out, kept for reference only:

- **Initial plans & roadmaps** that have been delivered or superseded
  (`INFRASTRUCTURE_PLAN.md`, `04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md`,
  `04-deployment/CLUSTER_UPGRADE_ROADMAP.md`, `05-infrastructure/MULTI_NODE_ROADMAP.md`, …)
- **Requirement specifications** for features that have since been built — the code
  and the (future) user manual are now authoritative
  (`02-operations/ADMIN_PANEL_REQUIREMENTS.md`, `02-operations/TENANT_PANEL_FEATURES.md`,
  `06-features/DATABASE_MANAGEMENT_UI_SPECIFICATION.md`, `08-admin-panel-mockups/`, …)
- **Descoped features** — removed from the roadmap by operator decision on 2026-06-07:
  - `06-features/PHP_COMPOSER_SUPPORT.md`
  - `06-features/AI_WEBSITE_EDITOR.md` (the shipped file-level AI editing is documented
    in the live feature docs; the no-code website editor was descoped)
  - `01-core/WEB_SERVER_PHP_VERSION_SWITCHING.md` (the capability exists via the
    workload/app catalog — see `docs/01-core/WORKLOAD_DEPLOYMENT.md`; the bespoke
    switching wizard spec'd here was never needed)
  - `05-advanced/MULTI_CLOUD_STRATEGY.md`, `05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md`,
    `05-advanced/MULTI_REGION_ADMIN_AND_COHOSTING.md`, `05-advanced/CONFLICT_RESOLUTION_MATRIX.md`
    (multi-region/sharding/co-hosting descoped entirely)
- **Migration & effort logs, spikes, evaluations** (`07-reference/MARIADB_MIGRATION_SUMMARY.md`,
  `04-deployment/RCLONE_SHIM_EVALUATION.md`, `06-features/STALWART_SUBPATH_SPIKE.md`, `diagnostics/`, …)
- **Previously archived docs** (`archived/`) and change notes (`CHANGES/`)

## Layout & links

Files keep their original `docs/` sub-paths (e.g. `docs/02-operations/X.md` →
`docs/history/02-operations/X.md`), so relative links **between** historical
documents still resolve. Links from historical documents **out** to live docs may
be broken — they are not fixed; these files are frozen artifacts.
The CI docs-link checker deliberately excludes `docs/history/`.

## Beware of stale content

These documents describe intentions, not the shipped system. Known examples of
content contradicted by the current platform: MariaDB as primary DB (now
PostgreSQL/CNPG), Redis caching (removed), NGINX ingress (now Traefik), Harbor
registry (GHCR is used), Velero backups (never adopted), Docker-Mailserver
(Stalwart shipped), Prometheus/Grafana/Loki stack (not deployed; see roadmap R2).
For the current system, read `docs/architecture/`, `docs/operations/`, and
`docs/features/`.
