<!--
Thanks for opening a PR. The checklists below are NOT decorative —
they catch the regression classes that have bitten this project
hardest. Strike through items that genuinely don't apply (e.g.
"~~Tenant data coverage~~ — no tenant code touched") rather than
deleting them.
-->

## Summary

<!-- 1-3 bullets: what changed and why. The "why" matters — keep
     this aligned with the commit message body, not the diff. -->

## Test plan

- [ ] Unit tests cover the new behaviour
- [ ] `npm run typecheck` clean (backend + admin-panel + client-panel)
- [ ] `npm run lint` clean
- [ ] If user-facing UI changed: exercised in a browser (not just the harness)
- [ ] If cluster-side: integration scenario added or extended in `scripts/integration-*.sh`

## Tenant Data Coverage (ADR-035)

Bundle capture is forward-only: a new tenant data dimension that
isn't wired into a component is silently dropped from every backup
until someone notices. **Answer all that apply** — leave a note for
items that don't:

- [ ] No new DB tables with `client_id` FK,
      **OR** the new table is in `CONFIG_DUMP_TABLES` (or in
      `CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES` with a reason)
      **AND** in `component-registry.ts`'s `tables` for the owning component.
- [ ] No new tenant-namespace PVCs,
      **OR** the PVC name template is added to `component-registry.ts`'s `pvcs`.
- [ ] No new tenant-namespace Secrets,
      **OR** the create-site has a `// backup-coverage: …` marker AND
      the Secret type is in `component-registry.ts`'s `secretTypes` (or
      excluded with a documented reason).
- [ ] No new external state (S3 bucket, vector DB, message queue),
      **OR** a new `BundleComponent` is registered AND
      `integration-bundle-coverage.sh` is extended to populate + assert it.

CI guards: `tenant-bundles coverage audit` (schema + resource audits)
must pass. Coverage tab on `/tenant-backup` shows zero orphans.

## Risk / blast radius

<!-- Reversible? Hard-to-reverse? Affects shared infrastructure?
     Mention any expected operator action post-merge (DB migration,
     manifest re-apply, etc.). -->

## Screenshots

<!-- For UI changes only. -->
