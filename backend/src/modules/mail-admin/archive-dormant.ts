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
 *                             no-downtime export, still built and still pinned
 *                             to Stalwart's RocksDB
 *   - `scripts/integration-stalwart-mail-ha.sh`  phases E and F, which fail at
 *                             once while the routes are gone
 * The `mail_archive_runs` table and the schedule columns in `system_settings`
 * are left as they are. Past archives stay in the backup target and nothing
 * prunes them any more; the runbook says how to list, restore and remove them.
 *
 * To switch it on again: set this to true and mount `<MailArchiveCard />` on
 * the Email → Operations page (it had a tab of its own, "Backups": see
 * `routes/tabbed-pages.ts` and `search/registry.ts`) — then prove a scheduled
 * run fires on a cluster before telling anyone it works.
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
