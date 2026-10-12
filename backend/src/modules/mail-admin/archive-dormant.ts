/**
 * The mail archive is switched off.
 *
 * It was a second way to back the mail server up — Stalwart's own logical
 * export (`stalwart --export`, a directory of `subspace_*` files) taken on
 * demand or on a schedule, next to the mail snapshots (restic of the data
 * directory) that the platform actually recovers from. Nothing else used it,
 * its schedule never fired (the due check compared against a "next run" time
 * that is always in the future), and nobody noticed. Snapshots cover recovery,
 * the standby copy covers failover, tenant bundles cover a single mailbox. What
 * only an export can do — move the mail store to another backend, or rebuild
 * one whose files are damaged — is a rare operation done by hand, with a
 * runbook that was run end to end: docs/operations/MAIL_STORE_EXPORT_IMPORT.md.
 *
 * The code is kept, compiled and tested, so it can be switched on again:
 *   - `archive.ts`            the orchestrator (export / restore Jobs, run records)
 *   - `archive-schedule.ts`   the schedule (the due check is fixed)
 *   - `routes.ts`             its seven routes, registered only when this is true
 *   - `app.ts`                its scheduler timer, started only when this is true
 *   - admin panel             `components/MailArchiveCard.tsx` + `hooks/use-mail-archive.ts`,
 *                             no longer mounted on Email → Operations
 *   - `images/rocksdb-secondary-checkpoint`  the checkpoint binary of the
 *                             no-downtime export — source only, see below
 *   - `scripts/integration-stalwart-mail-ha.sh`  phases E and F, which fail at
 *                             once while the routes are gone
 * The `mail_archive_runs` table and the schedule columns in `system_settings`
 * are left as they are. Past archives stay in the backup target and nothing
 * prunes them any more; the runbook says how to list, restore and remove them.
 *
 * The checkpoint image is not built, pushed, pinned, scanned or referenced by
 * any manifest while this is false. It opens the mail server's live RocksDB
 * store, so it must link the same C++ rocksdb as the Stalwart release in use;
 * the images left in the registry were built for Stalwart v0.16.26 and earlier.
 * What was unwired, and has to come back before the archive runs anywhere:
 *   - its build workflow: `images/rocksdb-secondary-checkpoint/dormant-ci-workflow.yml`
 *     → `.github/workflows/ci-rocksdb-secondary-checkpoint.yml` (refresh the
 *     action pins; Dependabot did not update the parked file)
 *   - the config key `rocksdb-secondary-checkpoint-image` in
 *     `k8s/base/platform-config.yaml` and in the development and production
 *     `platform-config-patch.yaml`, and the env var
 *     `ROCKSDB_SECONDARY_CHECKPOINT_IMAGE` in `k8s/base/backend-deployment.yaml`
 *   - the key in the PINNED list of `scripts/ci-config-image-pin-check.sh`
 *   - its Cargo entry in `.github/dependabot.yml`
 *   - `dormant: true` off its entry in `security/components.yaml`, and
 *     `images/rocksdb-secondary-checkpoint/osv-scanner.toml` deleted (it hides
 *     the crate's dependencies from the vulnerability scan)
 *   - the rocksdb pin re-verified against the Stalwart release of that day
 *     (`scripts/ci-rocksdb-stalwart-pin-check.sh --online`, then
 *     `tracks.verified_against` in the registry)
 * That guard passes without looking while this constant is false. With it true
 * it fails until each item is declared again and the rocksdb pin matches the
 * Stalwart release in use. It cannot tell whether the workflow's action pins
 * were refreshed — that part is on whoever switches the archive on.
 *
 * To switch it on again: set this to true, wire the image back in as above,
 * and mount `<MailArchiveCard />` on the Email → Operations page (it had a tab
 * of its own, "Backups": see `routes/tabbed-pages.ts` and
 * `search/registry.ts`) — then prove a scheduled run fires on a cluster before
 * telling anyone it works.
 *
 * Known before that day, found while writing the runbook:
 *   - The downtime mode and the restore scale the mail Deployment to 0 and
 *     leave Flux running. Flux owns that replica count and puts it back at its
 *     next reconcile, so a run longer than the Kustomization's interval gets a
 *     mail server started on top of it. Pause the Kustomization or hand the
 *     field over first.
 *   - The restore refuses an export "smaller than 1024 bytes" by `stat` on the
 *     export path. That path is a directory, whose size is its entry table —
 *     an empty one passes. Check for the `subspace_*` files instead.
 */
export const MAIL_ARCHIVE_ENABLED = false as boolean;
