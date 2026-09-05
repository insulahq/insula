# Changelog

All notable changes to Insula are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **CalVer `YYYY.M.PATCH`** (no leading-zero month — valid SemVer; [ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)).
Releases are cut ad-hoc with `scripts/cut-release.sh` (see [RELEASING.md](RELEASING.md)).

> A `### BREAKING` subsection in a release marks changes that break operators or
> APIs. Auto-update refuses to auto-apply any release whose section contains one
> until an operator acknowledges it.

## [Unreleased]

### Changed
- **Email pages lead with Storage Usage instead of "Mail Server: Stalwart".**
  That tile showed a constant — it never changed and told the operator nothing
  they could act on, while holding the most prominent slot in the row. The new
  first tile shows how much disk the mail data is actually using.
- **Per-node mail storage reports real free space instead of "Scheduled (PVC
  requests)".** Mail runs on `local-path`, where a PVC request reserves nothing
  and enforces nothing — a 30Gi request sat beside 63 MB of actual mail — and
  *Headroom* was computed as `total − scheduled`, so the fiction propagated
  into the one number an operator would act on. Both are replaced by the node
  filesystem's actual free bytes, read from the kubelet Summary API. Null (not
  0) when that read fails, since "0 B free" reads as a full disk.


### Added
- `ci-mail-image-pin-check.sh` — asserts every `stalwartlabs/stalwart` reference
  in `k8s/` and `backend/src` names the same tag, and that the stalwart-cli
  version + sha256 agree across both pins. `archive.ts` already carried the
  scar ("v0.16.5 while the server ran v0.16.14 — eleven releases of silent
  drift"); the unit test added then asserts the resolver against a literal in
  its own file, so nothing compared the files to each other. Now something does.
- **Compose validation errors now carry a line number.** The backend resolves
  each issue's dotted path (`services.db.deploy.resources.limits.memory`) back
  to the line it came from, the editor renders those as inline squiggles you
  can hover, and each entry in the Issues pane gets a **line N** button that
  scrolls the editor to it. Previously an issue said *what* was wrong but never
  *where*, so finding it in a 60-line stack meant reading the whole file.
  Unresolvable paths get no line rather than a guessed one. Validator issues
  are translated from normalized-spec coordinates
  (`services.db.resources.memoryLimit`) back to compose ones
  (`…deploy.resources.limits.memory`) first, so two errors about the same field
  no longer disagree about whether it has a line.

### Fixed
- **Rotating the Stalwart admin password showed the OLD password in the admin
  panel.** The rotation patches the Kubernetes Secret, but platform-api served
  the reveal endpoint from its *volume mount* of that Secret — and kubelet
  refreshes a mounted Secret up to ~60s late. The credentials query is
  deliberately `staleTime: 0` + `refetchOnMount: 'always'`, so the refetch that
  fires straight after a rotation re-read the stale file and overwrote the
  correct password the mutation had just seeded. The panel showed the previous
  password until a reload more than a minute later. The reveal endpoint now
  reads the Secret through the API — removing the window rather than racing it,
  and HA-safe in a way an in-process cache would not be. Falls back to the
  mounted file if the read fails, so a missing RBAC grant degrades instead of
  breaking the reveal.
- **DKIM status showed every RSA selector as "invalid"** in Email Management →
  Email Domains, on domains whose keys existed and whose mail was being signed
  and delivered normally. Stalwart wraps any TXT value too long for one line in
  parentheses, and an RSA public key always is; the zone-file parser worked
  line by line, so it matched only the record's opening line — which carries
  `_domainkey` and `TXT` but no quoted fragments — and skipped the
  continuation lines because they lack `_domainkey`. The selector was reported
  invalid with a blank TXT value and no public key. Ed25519 keys fit on one
  line, which is why the platform's own apex looked healthy while every tenant
  domain, which gets only the RSA selector, showed invalid. Parenthesised
  records are now folded into one logical line before parsing. Display-only —
  signing was never affected.
- **Clicking Validate on an untouched compose editor failed with a raw regex.**
  The stack name is optional for the preview, but the editor sent `name: ""`
  and `.optional()` accepts `undefined`, not an empty string — so the blank
  field hit the DNS-name pattern and returned
  `Invalid string: must match pattern /^[a-z0-9]…/` about a field the tenant
  had not filled in. The editor now omits the key when blank, which is what
  its own comment had claimed all along.
- Name validation errors describe the rule instead of printing the regex. The
  compose stack name and the inline config/secret names all had bare
  `.regex()` calls with no message, so Zod emitted the pattern verbatim.
- The single-container wizard no longer lets you click **Validate** before
  entering a name — simple mode requires one, so doing so produced a backend
  error about a field the form had not asked for yet. The button now explains
  what is missing.

### Changed
- **Stalwart 0.16.16 → 0.16.20.** Four patch releases, no migration — every one
  states that upgrading within 0.16.x is a binary/image replacement. The
  0.16.19 `ALTER TABLE` note applies only to MySQL/MariaDB data stores; this
  platform runs Stalwart on embedded RocksDB, so it does not apply. The
  RocksDB-checkpoint coupling was re-verified rather than assumed: Stalwart's
  own `Cargo.lock` pins the same `librocksdb-sys 0.17.3+10.4.2` / `rocksdb
  0.24.0` at both tags, so the checkpoint binary still links the same C++
  rocksdb as the store it opens. Brings ACME
  order-failure logging and retry fixes (mail TLS runs through Stalwart's
  http-acme), DANE and MTA-STS delivery fixes, and a `/api/discover` fix for
  master-user names containing `%`.
- **stalwart-cli v1.0.4 → v1.0.12**, version and sha256 moved together across
  both pins. The archive is checksum-verified by the Job, so a version bumped
  without its hash fails that check rather than running an unverified binary.
- Bulwark's image is digest-pinned, which hides the version. The manifest now
  records the version, how to re-resolve the digest, and why 1.9.2 is a floor.

### Removed
- `mail-admin/rotate.ts` and its test — a dead, restart-based Stalwart
  admin-password rotation superseded by the in-flight JMAP `Principal/set` path
  in `rotate-jmap.ts`, which is what the route actually calls. Nothing imported
  it but its own test. It also carried a latent defect that shows why it was
  never exercised: it verified the rotation by POSTing to `/api/oauth`, an
  endpoint that returns 404 on Stalwart 0.16.16 and 0.16.20 alike, so the poll
  could never have succeeded. Correcting a module no caller reaches would only
  have preserved an obsolete second model of how rotation works; the live path
  verifies against `GET /jmap/session` and needs no restart.

### Security
- **Bulwark webmail 1.7.8 → 1.9.2**, which fixes GHSA-24w9-8r42-8jwm: a
  DNS-rebinding SSRF reachable through the **unauthenticated**
  `/api/fetch-ical` endpoint. The public-host check ran before `fetch()` opened
  its socket, so a hostname under attacker control could rebind to loopback,
  RFC-1918 or cloud-metadata addresses in between and return up to 10 MB of the
  internal response. Redirect targets are now validated the same way.

## [2026.9.6] - 2026-09-04

### Added
- **Compose stacks can set CPU and memory.** `deploy.resources.{limits,reservations}.{cpus,memory}`
  is now parsed and mapped to Kubernetes requests/limits — reservations become
  requests, limits become limits, and a block with only `limits` mirrors them
  into requests (what Kubernetes itself does). Compose binary units are
  honoured (`512M` → `512Mi`, `1G` → `1024Mi`), CPU is normalised to
  millicores. The compose JSON Schema carries the new fields, so the editor
  autocompletes and documents them, and the pre-filled default stack
  demonstrates both forms.
- **Private-registry credentials can be supplied when creating a custom
  deployment**, in both the single-container wizard and the compose editor.
  The credential is stored and the pull Secret materialised *before* the first
  deploy, so a private image now pulls on the first attempt. When a token is
  given, the pre-flight image check uses it, and a registry that rejects the
  token fails the create with `IMAGE_CREDENTIAL_REJECTED` instead of the
  container surfacing it later as ImagePullBackOff. A creds-less 401 still only
  warns — that just means the image is private.
- **Image-pull Secret reconciler.** An idempotent hourly sweep (plus one at
  startup) recreates any `image-pull-<id>` Secret that is missing for a stored
  credential. Scoped per tenant on the restore path.
- The admin **Tenants** table now shows subscription **Expires** (colour-coded:
  red past due, amber within 30 days, "never" when unset) in place of Created,
  and the Worker column is now **Placement**, showing the pinned node or
  `auto` when the scheduler places the tenant.
- The compose editor's starter stack now names the private-registry checkbox,
  links the published tenant guide, and lists the other supported and rejected
  compose fields, so it works as a map rather than a dead end.

### Fixed
- **Custom container stacks could not be validated or deployed.** The CRS
  934xxx "Application Attack Generic" family blocked
  `POST …/custom-deployments/validate` and `…/custom-deployments` at the WAF
  edge — 934190 ("scheme-less localhost or internal hostname") matched
  `http://localhost/health`, which is the healthcheck in the platform's *own*
  default compose template, shipped pre-filled in the compose editor. The
  editor's untouched default stack was refused for every tenant. The family is
  now excluded on the four deploy endpoint groups alongside 932xxx (rule
  9000108), because a container spec legitimately contains service URLs,
  internal hostnames, config templates and Node/Ruby/Perl entrypoints.
  Traversal (930100/930110), restricted-files (930130) and the 941/942/933
  families remain enforced on every field.
- **Every compose service silently ran at 100m CPU / 128Mi memory.** `deploy:`
  was neither parsed nor rejected, so `deploy.resources` — the only way the
  compose spec expresses CPU/memory — was dropped without a word, and the
  rejection hint for the legacy `cpus:` / `mem_limit:` fields pointed at a
  "`resources` block" that did not exist anywhere. There was in fact no way to
  give a compose service more than the hello-world default.
- The remaining Swarm-only `deploy:` keys are now warned about instead of
  ignored. `deploy.replicas: 3` in particular said nothing while producing one
  pod.
- **CPU and memory are no longer hidden behind "Show advanced"** in the
  single-container wizard. They are a first-class *Resources* section showing
  the defaults inline, so a tenant deploying a real application sees the dial
  before meeting an OOMKill instead of after.
- **Restoring a custom deployment left it in the database and nowhere in the
  cluster.** The restore executor upserted rows only; `custom-deployments`
  has no reconciler that creates a missing workload (its reconciler is
  status-only), and the dockerconfigjson Secret never travels in a bundle.
  Restore now re-applies custom workloads through the same path DR recover
  uses and rebuilds their pull Secrets, reporting per-workload outcomes in the
  restore item's progress message. Deployments the tenant had stopped are left
  stopped.
- **The admin Tenants list never returned `nodeName` or `storageTier`.** Both
  columns are rendered from them, but the Fastify response schema did not
  declare either field and Fastify strips undeclared properties — so the node
  column showed `—` for every tenant and the tier column showed `local` for
  every tenant, including real HA ones. Both fields are optional in the
  contract, so TypeScript could never catch it.
- **The compose editor's own starter stack greeted every tenant with a warning
  about itself.** It shipped `traefik/whoami:latest` and `redis:7-alpine`,
  both moving tags, so the platform's own `UNPINNED_TAG_ADVISORY` fired the
  moment anyone clicked **Validate**. Pinned to real immutable tags, and a test
  now runs the shipped template through the real parser *and* validator and
  fails on any error or warning — the same class of bug as the CRS 934190
  block, where the platform's default violated the platform's own rules.
- The starter template pointed at a repository path
  (`docs/features/CUSTOM_CONTAINERS_USER_GUIDE.md`) that a tenant cannot open.
  It now links the published guide.

### Security
- Registry manifest lookups are SSRF-guarded. `resolveTagDigest()` fetches
  `https://<registryHost>/v2/…` with a host taken from the tenant's own image
  reference; the `WWW-Authenticate` realm had been validated since it was
  written, but the manifest URL itself had not. Both now go through the same
  validator, so `image: 169.254.169.254/x:1` or `image: kubernetes.default.svc/x:1`
  is refused before a socket opens. This replaces the partial, incidental cover
  the excluded 934xxx rules had been providing.

## [2026.9.5] - 2026-09-03

### Added
- **ntfy push notifications now have their own editable templates.** The ntfy
  channel shipped with a provider, a publisher, a delivery queue and an admin
  card — but not a single template. Nothing looked broken, because the
  dispatcher quietly borrowed each source's in-app wording instead, so pushes
  did arrive; ntfy was simply the one channel whose text an operator could not
  change, preview, version or restore, and **Settings → Notifications →
  Templates** listed nothing at all for it. Every source now ships an ntfy
  template of its own, seeded automatically on the next start. The template
  editor's subject field is also no longer email-only: it is the email Subject
  header, the in-app notification title and the ntfy push title — the string on
  a phone's lock screen — and all three are now editable, each under its own
  label. Two coverage gaps found on the way are closed in the same change:
  `tls.certificate_issued` had no email template despite email being one admin
  toggle away, and template lists silently ignored an unknown `channel` filter
  instead of reporting it.
- **A tenant holding more than their plan allows now says so on its detail
  page.** Changing a plan does not resize anything the tenant already has, so
  moving a customer from a 2 GiB plan to a 512 MiB one leaves the 2 GiB volume
  exactly as it was — the subscription says one thing and the cluster holds
  another, with nothing to announce the difference. It is easy to miss because
  the tenant's own storage figure is bytes *written*: a 2 GiB volume holding
  79 MB of files reads as comfortably inside a 512 MiB plan, while the first
  real symptom is a new volume being refused and a deployment stuck pending.
  The tenant detail page now compares all three numbers — what the
  subscription allows, what Kubernetes is enforcing, and what is actually
  provisioned — and flags the rows that disagree. It catches both shapes: the
  one where the quota was lowered too (so new resources are already being
  rejected) and the one where it was not (so nothing looks wrong yet, but the
  tenant is still over their entitlement). **Run reconciler** is deliberately
  not offered, since it recreates missing objects and this object exists and is
  simply the wrong size; the banner points to the two things that do work —
  raise the limit, or shrink the volume.
- **Tenants can download their own SSL certificates.** The certificate and
  private key for a domain were only ever reachable from inside the cluster, so
  a customer who also runs their own mail server or appliance on that domain
  had no way to get them. The domain's **SSL/TLS** tab now has a
  **Certificate files** panel with a download button, and an **API access**
  section for creating scoped tokens so an external server can fetch the
  renewed certificate on its own — platform-issued certificates renew about
  every 60 days, and clicking a button that often is not a plan. A token is
  bound to a single domain, is read-only, can be revoked instantly, and is
  shown exactly once. It also works when the platform uses single sign-on,
  where there is no password for a script to log in with. Admins get the same
  download plus the ability to revoke a customer's token for support, but
  cannot create one — that secret belongs to the customer. Every download,
  by button or token, is recorded in the audit log.

### Changed
- **The metrics database now collects a smaller, more useful set of data.** It
  had been running close enough to its memory ceiling to be killed and
  restarted every few days, leaving short gaps in the graphs. Rather than give
  it more memory — it is already about a tenth of the platform's whole
  footprint — it has stopped collecting series that nothing reads: per-backend
  and per-API-route latency percentile breakdowns, and the Go runtime's
  internal garbage-collection and scheduler timings from every component. That
  is roughly a fifth of everything collected. Nothing shown in the dashboards
  or used by the alerts and service-level objectives changed, including the
  request-latency percentiles for public traffic. Average request duration per
  backend is still available; only the percentile detail for those two
  families is gone. Metric retention stays at 30 days.

### Removed
- **The nightly "backup coverage audit" job has been retired.** It checked
  whether storage volumes carried a label that used to control Longhorn's
  own off-cluster volume backups. That mechanism was retired in August, when
  protection moved entirely to the tenant, mail and system backup targets you
  assign under **Backups** — which is why there is no longer any way to
  configure a Longhorn backup target in the admin panel. Since then the audit
  had been reporting a missing *backup* for volumes that were at most missing
  a local hourly snapshot, and because of the storage classes it filtered on
  it could not see tenant volumes at all. It therefore failed every night
  without ever reporting anything true — 21 nights in a row on one production
  cluster. Nothing about what is actually backed up changes. Hourly local
  snapshots and the daily filesystem trim continue exactly as before.

### Fixed
- **Rebooting a node no longer leaves hundreds of failed pods behind.** After a
  restart the pod list filled up with pods in a failed state, all reporting
  that they had been rejected because the node was shutting down — 822 of them
  from a single production reboot. They were harmless leftovers rather than a
  fault, but they buried real failures and made a healthy cluster look broken.
  All of them came from the Calico operator, which was being stopped in the
  very first shutdown wave and then repeatedly restarted onto a node that was
  already going down. It is now stopped in the same wave as the rest of the
  cluster's core networking components, so the loop no longer happens.
- **A storage operation that cannot restart your applications now fails
  visibly instead of leaving them stopped.** Snapshots, resizes, restores and
  filesystem checks briefly stop a tenant's applications so the volume can be
  worked on safely, then start them again. If that restart failed — most often
  because the tenant was at its memory limit and the platform was not allowed
  to start the pod — the error was discarded: the operation reported success
  and the applications simply stayed stopped, with nothing anywhere to say
  why. The self-healing watchdog could not find them either, because the
  marker it searches for had already been removed a moment earlier. Now the
  applications are started first and the marker is only cleared once they are
  back, every failure is logged with the reason, and an operation that cannot
  bring an application back is marked **failed** so it is visible in the panel
  and retried automatically.
- **Four more operational history tables are now pruned on a schedule.** The
  platform already pruned its audit trail and most per-event tables, but the
  record of upgrade attempts, Apply HA/Local runs, DR drills and image reaps
  had no retention at all and would grow for the life of a cluster. They are
  now cleaned up alongside everything else — 90 days for the operational ones,
  180 for DR drills, which are the evidence that restore actually works. An
  upgrade or apply that is still running is never removed, however old it is.

## [2026.9.4] - 2026-09-02

### Fixed
- **A route that only redirects now works.** An ingress route with no
  deployment and a redirect URL was accepted and stored, but never turned into
  anything the ingress could serve — the hostname answered 404. Such a route is
  now published like any other, and answers every path with a permanent
  redirect (HTTP 301). Use it for a domain you own but do not host, or an
  address you are retiring. A route with neither an application nor a redirect
  is still skipped, as before.

- **The route Redirect URL and rate-limit burst settings now save.** Both
  fields were sent under a different name than the API expects, so saving them
  returned success and changed nothing — on every route, on every cluster. The
  settings endpoints now reject an unrecognised field outright instead of
  quietly ignoring it, so a mismatch can never again look like a successful
  save.

- **Every route response now has the same shape.** Depending on which endpoint
  answered, the same route came back with numeric `0`/`1` flags or with
  true/false. Listing, fetching, creating and updating a route all use one
  representation now.

- **SQL Manager could permanently lose access to a database that was deleted and
  re-created under the same name.** A deployment's storage folder is derived from
  its type, application and name, and deleting a deployment without also deleting
  its data leaves that folder behind — so re-creating one with the same name
  mounts the previous data directory. Database engines only apply the configured
  root password when they initialise an *empty* directory, so the newly generated
  password was silently ignored and every SQL Manager call failed to authenticate
  from then on. The password-reset step that already existed for this situation
  was only armed when an operator explicitly picked an existing folder; it now
  runs for every database deployment. It costs nothing when there is no previous
  data (it checks first and exits), and it can no longer take a database offline
  if it fails — including a PostgreSQL case where an interrupted reset could have
  left the database trusting every local connection.

- **SQL Manager showed "no databases" instead of the actual error.** When the
  database list, table list or user list could not be read, the panel discarded
  the failure and rendered an empty picker — so an authentication or connection
  problem looked like an empty database. These now show the error, with a retry.

## [2026.9.3] - 2026-09-02

### Added
- **Search and a list view on the tenant panel's Installed Apps tab.** The tab
  showed every deployment as a card with no way to find one — workable for
  three applications, not for thirty. There is now a search box that matches on
  the deployment name, the application it was installed from, its type and its
  status (so "the failed one" or "the databases" are findable), and a
  grid/list switch matching the admin panel's Installed tab. The list is a
  dense sortable table — name, application, type, status — with the same Start/
  Stop, Preview, Details and Delete actions as the cards. Your choice of grid or
  list is remembered between visits.

- **Mailbox migrations now report a one-line outcome when they finish.** A
  completed migration showed only a status badge: the progress figures came
  from imapsync's per-message copy lines, so a run that moved nothing produced
  no figures at all and the panel had nothing to display. Each finished
  migration now records a summary read from imapsync's own final statistics —
  for example *"Transferred 1,204 messages across 12 folders (84.2 MiB) in
  3m 41s"*. **Skipped messages and errors are named in that line on purpose**:
  imapsync silently skips messages it cannot identify, and a run that reports
  success while quietly skipping half a mailbox is not something you should
  have to read logs to discover. Re-running a migration now also clears the
  previous run's summary along with its logs.

### Fixed
- **Staying signed in while a tab is left open.** The tenant and admin panels
  only renewed a session when the browser had seen mouse, keyboard or scroll
  activity in the previous 25 minutes. A tab left open on a page you were only
  reading produced none of those events, so nothing renewed the session and it
  eventually lapsed. Renewal also gave up entirely once the sign-in had already
  expired — exactly the state a tab comes back in after sitting in the
  background — leaving it to the next click to notice.

  An open tab is now enough on its own, and a tab is re-checked the moment you
  switch back to it. Sessions are also renewed by a single tab at a time:
  re-using an already-rotated token is treated by the API as a stolen-token
  signal and ends every session, so several open tabs renewing at once would
  have signed you out of all of them.

  **Impersonation is unchanged**: "Login as Tenant" still issues a one-hour
  session that cannot be renewed, and still ends after that hour.

- **Moving or copying many files at once could fail partway with "Too many
  requests" while the file manager appeared to restart.** Selecting a large
  group of files and moving them sent one request *per file*, all at once — a
  120-file move produced 62 requests in two seconds. That exceeded the API rate
  limit, and the rejections spilled over into the rest of the page: the file
  listing, the task list and the file-manager status check were all refused at
  the same time. With the status check failing, the Files page fell back to its
  "Starting file manager…" screen, so a file manager that was running normally
  the whole time looked as though it had crashed and restarted.

  The move also stopped reporting as soon as the first request was rejected,
  even though the others kept succeeding in the background. The result was an
  error message about a move that had partly worked, with no indication of
  which files had actually moved — and retrying reported "Source not found" for
  everything the first attempt had already moved.

  Move, copy, delete, permissions and ownership now each send the whole
  selection as a **single** request, with a progress dialog showing the running
  count and the file being worked on. It closes itself when everything
  succeeds, and stays open listing exactly which paths failed and why when only
  some do. A rate-limited status check no longer renders as "starting", and no
  longer retries every two seconds against the limit that is rejecting it.

  Nothing about how files are stored changed, and no action is needed on any
  cluster — existing installations are fixed by upgrading.

- **A custom container deployment could fail to start with no error, no
  timeout and no feedback at all.** Every diagnostic the custom-deployment
  reconciler had was read from a Pod. When Kubernetes *refuses* a deployment
  outright — most commonly because it would exceed the subscription's CPU or
  memory quota — no Pod is ever created, so there was nothing to read and the
  deployment simply sat at "pending" indefinitely. The reason exists only on
  the ReplicaSet, which the catalog deployments already inspected and custom
  ones did not. Custom deployments now read the same place and report, for
  example, *"Quota exceeded — CPU request: requesting 4, already using 250m of
  4 limit. Free up resources or upgrade the plan."* Such a deployment is marked
  **failed** rather than pending, because a refusal does not clear on its own —
  something has to change first.

- **Migrating a mailbox left messages in a lowercase `spam` folder behind.**
  Source folders named `Spam`, `Junk` and `junk` were already mapped correctly;
  an all-lowercase `spam` was not, and instead created a stray folder on the
  destination that no spam filter or mail client would ever look in. All four
  spellings now land in the real junk folder. Existing migrations pick this up
  when re-synced — no re-configuration needed.

## [2026.9.2] - 2026-09-02

### Fixed
- **Mailbox migration (IMAPSync) failed on every real cluster.** Starting a
  migration returned `STALWART_MASTER_SECRET is required (mail-imapsync
  routes)`. The backend read Stalwart's master password from an environment
  variable that was only ever set in the local development overlay, so the
  feature worked when developing locally and nowhere else. The migration job
  now reads that password directly from the mail namespace's existing
  `mail-secrets` Secret, the same way tenant-backup mailbox jobs and the Plesk
  migration already did. No configuration change is needed on any cluster —
  existing installations are fixed by upgrading.

  As a side effect the master password no longer passes through the management
  API or gets copied into the per-migration Secret; only the password for the
  *source* mailbox being migrated from is stored there, and it is still deleted
  along with the job.

- **Mailbox migration failed to log in to the destination mailbox.** Once the
  above was fixed, migrations still failed — the job authenticated to the mail
  server as `<mailbox>%master`, using a short name the mail server does not
  accept, and gave up with an authentication error after transferring nothing.
  It now uses the full master address the mail server expects, so a migration
  actually delivers the mail.

  These two defects together meant mailbox migration had never worked outside a
  developer's machine. Both are now covered by an end-to-end test that migrates
  a real mailbox and checks the messages arrived
  (`scripts/integration-mail-imapsync-e2e.sh`).

- **Resizing, stopping or deleting a custom container silently did nothing.**
  Changing the CPU or memory of a bring-your-own-container deployment, stopping
  it, restoring it or deleting it reported success while the running container
  was never touched. The panel showed the new figure and the new status; the
  container carried on exactly as before.

  On a tenant that had given a custom container its whole CPU allowance this was
  not cosmetic. Reducing it to make room for a second application appeared to
  work, but the original container kept every core — so the new application
  could never start, and reported a resource-quota error that contradicted what
  the panel displayed.

  The cause was that all of these actions were written for catalog applications
  and quietly skipped their Kubernetes half whenever a deployment had no catalog
  entry, which is by definition true of every custom container. They now perform
  the change. Deleting a custom container permanently also removes its
  Kubernetes objects — previously it removed the database record and left the
  container running, consuming the tenant's quota with nothing left in the panel
  to explain it.

  A resource change on a custom container now updates the container's own
  specification rather than a summary field derived from it, so the change
  survives later redeploys. Multi-service (compose) stacks declare resources per
  service and are now declined with an explanation pointing at the YAML editor,
  instead of accepting a change that cannot be applied unambiguously.

- **Databases displayed a permanent "Last error" that was not an error.** Every
  database and internal service showed *"Catalog type 'database' cannot be
  exposed via Ingress"*, re-applied whenever any routing in the tenant changed,
  overwriting genuine errors and never clearing. Databases are reachable only
  from inside the cluster by design; that is now treated as a normal property
  rather than a fault. A real misconfiguration — an application that should be
  routable but declares no web port — is still reported.

- **The deploy dialog offered an ingress route for databases.** Choosing one had
  no effect, because the platform correctly refuses to route external traffic to
  a database. The step is now hidden for databases and internal services, with a
  note explaining that other applications reach them by service name.

- **Resource usage on the admin tenant list could be up to an hour out of date.**
  The list served whatever a background sweep had last collected, which also
  meant different figures depending on which API replica answered, and no
  figures at all for a tenant that replica had never collected. It now collects
  current usage as the list loads — oldest entries first, in bounded batches so
  a large fleet does not overload the cluster API.

### Changed
- **Dependency currency sweep.** npm minor/patch group (20 packages), Go
  `k8s.io/client-go` and friends across the firewall-reconciler,
  host-config-reconciler, security-probe and sftp-gateway images, and the
  GitHub Actions group.

  `tar-stream` 3.2.1 is a patch release that began shipping its own TypeScript
  declarations, which silently replaced the ones the backup and restore paths
  were written against and described the library's internal stream types
  instead of Node's. No runtime behaviour changed, but the mismatch is now
  contained in one documented place rather than worked around at each call
  site.

### Fixed (developer tooling)
- **`local.sh mail-up` did not produce a working mail server.** The local
  development stack brought Stalwart up without the listeners that IMAP,
  message submission and certificate issuance need, so anything exercising mail
  locally failed against a server that looked healthy. It now runs the same
  configuration sequence `bootstrap.sh` uses on a real cluster. The local apex
  moved from `k8s-platform.test` to `insula.host`, because certificate issuance
  rejects a reserved `.test` domain and aborted the sequence before the
  listeners were ever created. Affects local development only.

## [2026.9.1] - 2026-09-01

### Changed
- **Dependency currency sweep** (resolves all eight open Dependabot PRs). npm:
  `@kubernetes/client-node` **2.0.0** (major — the client every cluster
  operation in the backend goes through), plus the minor/patch group (Fastify,
  the AWS SDK v3 S3 packages, the Anthropic SDK, Vite 8, ESLint 10,
  `@vitejs/plugin-react` 6, `lucide-react` 1.33). Go: `k8s.io/client-go`
  v0.36.4 across the firewall-reconciler, sftp-gateway, host-config-reconciler
  and security-probe images. GitHub Actions: `docker/setup-buildx-action` v4 and
  the CodeQL upload action.

  Verified on a live cluster rather than by CI alone: all four Go components
  reconciling with fresh output, the backend serving on client-node 2.0.0, and
  the API surface exercised end to end.

### Added
- **Recycle bin for the file manager.** Deleting a file or folder in the tenant
  file manager now moves it to a recycle bin on the tenant's own volume instead
  of erasing it, and it can be restored from there. Because the bin lives on the
  same volume, a delete is an atomic rename — instant even for a multi-gigabyte
  folder, and it consumes no extra space.
  - Every delete dialog now reads **Move to Trash**, with an opt-in *Delete
    permanently (skip recycle bin)* that switches the dialog's wording, button
    and styling together. The opt-in resets each time a dialog opens and is
    never remembered, so it cannot silently make a later delete unrecoverable.
  - **Undo** appears immediately after a delete, restoring *alongside* anything
    that has since taken the path rather than overwriting it. The bin also has
    a persistent toolbar button, multi-select for bulk restore/delete, and a
    filter.
  - **Deleting an application with its data folder** routes that folder through
    the bin too, so the files stay recoverable. Restoring returns the files
    only — not the application.
  - The bin has **no size cap**, by design: a size-driven purge would delete one
    tenant's files because another filled it. Instead its size is shown wherever
    storage is, because trashed files keep counting against the tenant's quota
    until they expire or the bin is emptied.
  - Retention is admin-configurable under **Platform → Limits & Regional**
    (1–365 days, default 14). Expiry runs both opportunistically while a tenant
    is using their file manager and from a background reconciler, so the window
    is honoured for tenants who delete something and never come back.
  - Trashed files are included in tenant backup bundles, so restoring a bundle
    also restores what was recoverable at capture time.
  - The bin holds files a tenant **deletes** in the file manager. It is not a
    version history: overwriting a file — moving or copying onto it, uploading
    over it, saving in the editor, or extracting an archive over it — replaces
    it outright, and retaining a copy on every routine write would grow the
    tenant's volume without bound. Files removed over SFTP or by the tenant's
    own application are likewise gone immediately.

### Fixed
- **Opening the file manager works on the first attempt after an update.**
  The first attempt to open Files after the file-manager image changed was a
  silent no-op — the panel reported "Pod is being created" while nothing was
  scheduled, and the tenant had to click again. The same path could also scale
  down a file manager that a tenant was actively using, mid-session, purely
  because the image pin had moved.
- **No more false "tenant OOM-killed" alerts.** Admins were paged that
  tenant `"traefik"` had a container OOM-killed and told to raise that tenant's
  plan. `traefik` is a platform namespace, no such tenant exists, and it was
  not an OOM: the container's cgroup reported `oom_kill 0` with an 8.5 MB peak
  against a 64 MiB limit, and the node's kernel ring buffer held no cgroup OOM
  for it at all. Three separate defects, all fixed, none by adding memory:
  - The `modsec-crs` `audit-redactor` sidecar never handled shutdown. `exec
    tail … | sed` does not replace the shell (a pipeline runs in subshells), so
    PID 1 stayed `/bin/sh`; and the image sets `STOPSIGNAL=SIGQUIT`, which
    busybox `ash` **ignores**. Every rollout therefore sat out the full 30 s
    grace period and was SIGKILLed. Now traps TERM/INT/**QUIT** and forwards to
    the process group: measured 31 s → **1.0 s**, exit 137 → **exit 0**.
  - Exit code 137 is `128+SIGKILL` from *any* cause, so it can no longer be
    reported as a confirmed OOM. Unconfirmed kills are worded as such, are
    dropped entirely for pods that are terminating (that SIGKILL is by design),
    and no longer trigger "raise the tenant's memory limit" advice.
  - Namespace classification failed **open**: the alert path listed 9 SYSTEM
    namespaces out of production's 27 and treated everything else as a tenant,
    misclassifying eleven platform namespaces — including `monitoring`, where
    the one workload that genuinely does OOM lives. Classification is now a
    single shared helper keyed on the `tenant-` prefix, so an unknown namespace
    fails closed to *platform*.
- **Tenant Secrets are labelled correctly in DR bundles.** `restoreTierForNamespace`
  still matched a `client-*` namespace convention the platform no longer mints,
  so every real tenant Secret was tagged `unclassified` instead of
  `tier-2-tenant`. Bundle contents and restore behaviour were unaffected (both
  tiers are bundled and applied by the `full` profile) — only the audit UI and
  bundle summary were wrong.
- **Platform "tax" headroom was over-stated.** `failover-headroom` classified
  the tenant side by prefix but the system side by a 13-entry list, so requests
  from `monitoring`, `crowdsec`, `dex`, `oauth2-proxy` and others counted as
  neither tenant load nor platform tax.
- **A staging NetworkPolicy probe had never once run.** It selected a probe
  namespace with `-l client`, a label nothing sets, and took its "skipping"
  branch on every execution while reporting success.

### Added
- `scripts/ci-namespace-classification-check.sh` (CI): tenant-vs-platform is
  decided in exactly one place, the helper may not regrow an enumeration, and
  the alerting path must distinguish confirmed OOMs from inferred exit-137
  kills. Curated *selections* (e.g. which namespaces get PVC snapshots) stay
  exempt with a stated reason.

## [2026.8.27] - 2026-08-31

### Fixed
- **Expired tenant backups now actually free storage, and their entries leave
  the list.** [ADR-048](docs/architecture/adr/ADR-048-tenant-backup-restic-jmap.md)
  specified that the retention sweeper calls `restic forget … --prune` for the
  deduplicated components; only the legacy half shipped. Expiry deleted a
  bundle's own directory and marked it `expired`, but the `files` and
  `mailboxes` snapshots live in a shared per-tenant restic repository in a
  sibling path that nothing ever touched — there was no `restic forget` and no
  `restic prune` anywhere in the platform. Two consequences: storage grew
  monotonically (only the tens-of-KiB config/secrets artefacts were ever
  reclaimed), and the retention window was **not honoured for tenant file and
  mail content** — a bundle read `expired` while its data remained fully
  present and restorable. A reconciling sweeper now compares each repository
  against the bundles still on file and forgets the rest, so it also reclaims
  snapshots orphaned by earlier expiries and by bundles deleted directly.
  Deleting a bundle from the admin panel now forgets its snapshots *before*
  dropping the row, which is what created those orphans. Once every part of a
  bundle is genuinely gone, its row is removed instead of lingering as an
  `expired` tombstone — a bundle spanning two repositories stays listed until
  both are swept. Restores were never at risk: restic is content-addressed,
  every snapshot is independently restorable, and nothing was deleting from the
  repositories at all.
- **WAF no longer blocks ordinary application deploys, cron jobs or the app
  terminal.** The CRS 932xxx "Remote Command Execution" family matches shell
  text by design, and the deployment / custom-deployment / cron-job endpoints
  exist to carry shell text — so the platform's own catalog defaults were
  refused at the edge. Measured: `PHP_ERROR_LOG=/dev/stderr` (the Apache+PHP
  catalog default) hit 932160, `/bin/sh -c …` hit 932250,
  `docker-php-entrypoint apache2-foreground` hit 932260, and
  `… && exec php-fpm` hit 932235. Exclusions 9000108/9000109/9000110 each
  carried a *different* subset of the family, so a value allowed on one
  endpoint was blocked on its sibling. They are now one rule covering
  deployments (including `…/<id>/terminal`), custom-deployments, tenant
  cron-jobs and **admin cron-jobs** (`/admin/cron-jobs` and `…/bulk` had no
  exclusion at all). Traversal, restricted-files and the XSS/SQLi/PHP
  injection families remain fully enforced on these endpoints.
- **WAF rule exclusions created from the panel now actually work.** The scope
  selector defaulted to `args_names_only`, which emits
  `ctl:ruleRemoveTargetById=<id>;ARGS_NAMES` — a no-op for any rule matching
  argument *values*, i.e. most of them. An operator could whitelist a rule,
  see it saved and reconciled, and still be blocked. A new `args` scope
  (removing both `ARGS` and `ARGS_NAMES`) is now the default and the
  recommendation in both panels.

### Added
- `scripts/ci-waf-scope-coverage-check.sh` (CI): every exclusion scope in the
  shared contract must be selectable in both panels, and neither panel may
  re-declare the scope union locally.
- `make waf-probe` now covers the catalog's real default env values, cron and
  app-terminal commands, and performs a create → verify-unblocked → delete →
  verify-reblocked round-trip, so "the exclusion saved" can no longer pass for
  "the exclusion worked".

## [2026.8.26] - 2026-08-31

### Added
- **Extra volume mounts for deployments.** A deployment can now mount an
  *additional* folder from the tenant's storage at a chosen absolute path
  inside the container, alongside the folder it already gets. The folder is
  addressed relative to the **storage root** rather than to the app's own
  folder, so two deployments naming the same folder see the same files — a
  shared media library, or a drop-box one app writes and another reads.

  Mount paths are validated by a shared schema **at the API boundary**, not only
  in the browser: absolute paths only, `.`/`..`/`//`/NUL rejected, kernel
  interfaces (`/proc`, `/sys`, `/dev`) and container system directories (`/`,
  `/etc`, `/usr`, `/var`, `/bin`, `/lib`, …) refused, a per-deployment cap, and a
  collision check against the volumes the platform already mounts.

  A shared folder deliberately **outlives the deployment**: deleting an app —
  even with *delete data* — removes only that app's own folder, because another
  deployment may still be using the shared one. Remove it from the File Manager
  when it is no longer wanted.

## [2026.8.25] - 2026-08-30

### Fixed
- **Every database user created through the panel had a password nobody had
  ever seen.** Both tenant-panel database screens generated a password in the
  browser, sent it to the API, and displayed the value they had generated. The
  API **ignored** the submitted value, generated its own, applied that to the
  account, and returned it — and the panel discarded the response. So the
  password shown was never the account's password, on **every** create and
  **every** regenerate. The only symptom was `Access denied` from the tenant's
  own application, with a correct username and correct grants, which is close
  to undiagnosable from the UI.

  Identified from the charset: the panel's generator used `!@#$%^&*` while the
  server's is `[a-zA-Z0-9_-]`, so a displayed password containing a symbol
  proved it had never been applied. Both panels now display
  `response.data.password`; the client-side generators are deleted; and the API
  **rejects** a submitted password with 400 rather than silently ignoring it,
  so the divergence cannot return quietly. Guard:
  `ci-server-generated-credentials-check.sh`.
- **"All databases" granted no databases.** The user-creation form's default
  option sent no database, and the backend only issued a `GRANT` when one was
  named — leaving `GRANT USAGE ON *.*`, which means no privileges at all. The
  account could authenticate and was then denied everywhere. It now grants
  `ALL PRIVILEGES ON *.*` on the tenant's own instance (no `GRANT OPTION`), the
  option says so, and the form preselects a real database so least privilege is
  the default. PostgreSQL grants on each existing database instead.
- **Re-creating an existing database user silently kept the old password.**
  `CREATE USER IF NOT EXISTS … IDENTIFIED BY` is a no-op when the user exists,
  and PostgreSQL's path skipped creation entirely — so a retry left the old
  password active while presenting a new one. Both now always apply the
  password with `ALTER USER`.

## [2026.8.24] - 2026-08-30

### Fixed
- **The WAF blocked ordinary filenames across the whole API, not only in the
  File Manager.** CRS 930130 matches argument values against a dictionary of
  restricted filenames (`.htaccess`, `.htpasswd`, `web.config`, `.git/*`,
  `wp-config.php`). In a hosting control panel those are ordinary data.
  Measured on DEV, every one of these was a 403 that never reached the API:
  renaming/copying/deleting such a file, creating an SFTP user with a
  `/.git/config` home path, a database named `web.config`, a domain
  `.htpasswd.example.test`, and a DNS record named `.htaccess`. The rule is now
  scoped away from **ARGS on the platform's own API hosts only** — traversal
  detection (930100/930110) keeps full coverage, so `../../etc/passwd` still
  blocks, and a tenant's own workload on their own domain keeps the complete
  rule set. This is a deliberate posture change; see the note in
  `exclusion-rules-configmap.yaml`.
- **The WAF blocked ordinary file operations on ordinary filenames.** After
  extracting a CMS archive, renaming or opening files such as `.htaccess` or
  `web.config` failed with a 403 from the WAF. CRS 930xxx match argument
  *values* against a dictionary of interesting OS filenames — and the
  file-manager API's arguments **are file paths**, so a tenant touching their
  own `.htaccess` scores 5 per matching argument. Reproduced exactly:
  `rename .htaccess → .htaccess2` scored **10** (both arguments match) and was
  blocked; `web.config` scored 5 and was blocked; `normal.txt` passed. An
  earlier exclusion had removed argument *names* from these rules, which does
  nothing for a path in the value. Path traversal is refused by `safePath()` in
  the sidecar regardless, so the WAF was contributing false positives and no
  defence on these endpoints.
- **The WAF blocked the request that disarms the WAF.** A rule exclusion
  describes an attack pattern — that is its purpose — so submitting one put
  attack-shaped text through the WAF, which blocked it. The operator was told
  to open Security → WAF Events and whitelist the rule, and *that* request was
  refused with the same message. The safety valve sat behind the thing it
  disarms. The WAF-management endpoint is now routed around the WAF (it is
  `super_admin` + Bearer-only, so the WAF was never the access control), and a
  CI guard checks both that the carve-out exists and that drift detection
  tracks it — an untracked carve-out looks in-sync forever and is silently
  never applied.
- **File-manager failures were invisible.** Nine mutation call sites passed
  only `onSuccess`, so a failed rename, move, delete, archive, git-clone or
  save rendered nothing at all — the dialog simply sat there. The 403 had been
  classified correctly the whole time; the message had nowhere to go. Every
  file-manager mutation now reports through one wrapper to a shared banner, so
  a new operation cannot silently join the class, and a WAF block additionally
  explains that a filename triggered a security rule.

## [2026.8.23] - 2026-08-30

### Added
- **Extract and archive show real progress.** Both stream NDJSON to the panel
  like `fetch-url` already did, so a multi-minute job reports what it is doing
  from the first second. Zip extraction shows a true percentage — the member
  count comes from the archive's central directory, read directly with no
  subprocess and no full scan. Tar extraction and archive creation report a
  running file count with **no** percentage, because neither total is knowable
  without walking the data twice, and an invented percentage is worse than an
  honest count.

  The per-file chatter that caused the bug above is what feeds this.

  The extract dialog's old progress bar was `width: 70%` with a pulse
  animation — a fixed decoration that looked identical for a 3-file archive and
  a 14,191-file one. It now tracks real counts, and falls back to an
  indeterminate bar only where no total exists.

### Fixed
- **Recursive permission and ownership changes were capped at 60 seconds.**
  Applying permissions with *Apply recursively to all contents* ran `chmod -R`
  under a fixed 60-second total timeout and `execFile`'s 1 MiB output buffer —
  the same defect that made large archives impossible to extract, in the two
  handlers the archive fix did not touch. On a CMS tree of tens of thousands of
  files on network storage the timeout kills the tool partway, leaving
  permissions **half applied** behind a generic error, which is worse than
  failing outright because a partly-chmod'ed tree looks fine until something
  403s. Both now run verbosely through the streaming runner: no total timeout,
  no buffer to overflow, and an accurate count of what changed.
- **A failed permission change blamed the archive.** The shared failure helper
  answered "the archive appears to be damaged or unreadable" for `chmod` and
  `chown` once they started using it. It is now subject-neutral, and it no
  longer relays the tool's stderr — an intermediate version did, which put an
  internal filesystem path into a message shown to the tenant.

- **Archives with many files could not be extracted, and archiving a large
  folder could fail the same way.** A tenant could not extract a 14,191-entry
  zip: the archive was valid, the disk had 4.6 GB free, and the extraction
  itself takes 5 seconds. The panel said only "Failed to extract archive".

  `execFile` buffers a child process's stdout and **kills the child** once it
  exceeds `maxBuffer`, which defaults to 1 MiB. `unzip -o` prints one line per
  member — 1,513,063 bytes for that archive, 44% over the cap. Extraction
  therefore worked for every small archive it was ever tested with and could
  never work for a large one, and nothing in the failure pointed at output
  buffering. `zip -r` (creating an archive) is chatty in exactly the same way
  and had the same latent limit; `git clone` writes progress to a
  similarly-capped stderr.

  Extraction and archive creation no longer buffer tool output at all. They
  `spawn` and read line by line, holding one line at a time, so memory is
  independent of file count and there is no cap left to exceed. The fixed
  120-second total timeout went with it — the wrong shape for "any size", since
  it is generous for 14k files and far too short for two million — replaced by
  an **idle** timeout that fires only when a tool goes silent. `git clone` keeps
  a bounded buffer with an explicit 32 MiB limit.

  Failures now report what actually went wrong — damaged archive, stalled tool,
  out of space — instead of one generic sentence, which is what sent this
  investigation to the wrong place.

- **The monitoring pod was OOM-killed every ~2 days, and the interval was
  shrinking.** VictoriaMetrics died five times in eleven days on the production
  cluster (3d16h → 2d18h → 1d23h → 1d14h between kills), each time losing its
  caches and starting the climb again. Neither usual suspect was involved:
  16.2k series total and 134 MB on disk.

  `-memory.allowedBytes=192MiB` budgets VM's **caches**, and the comment above
  it claimed that capped them "well under" the 384Mi limit. It does — and it
  says nothing about the Go runtime that shares the same cgroup. Measured: 246
  MiB held by the Go heap for an 89 MiB live working set, plus ~95 MiB of
  fastcache allocated as anonymous mmap *outside* the Go heap where
  `allowedBytes` accounting cannot see it either. 341 MiB against a 384 MiB
  ceiling. The limit only held because the caches never claimed what they had
  been permitted — `storage/tsid` held 13,505 entries in 32 MiB against a
  128 MiB ceiling, so a single cache-warming query could have killed the pod
  outright.

  Addressed by budgeting all three consumers instead of one, with no extra
  memory: `-memory.allowedBytes` cut to 64MiB, `GOGC=40` so the heap collects
  at 1.4× live instead of 2× — the pod uses 6m of a 100m CPU request, so the
  trade is free — `GOMEMLIMIT` as a backstop, and `metric_relabel_configs`
  dropping 4,665 series (29 %) that were never read: Longhorn's and Flux's
  client-go internals, per-container swap gauges that are constant zero because
  swap is disabled, VM's own flag list, and one series per Postgres GUC.

  **Two of those levers did not do what was claimed for them, and the
  measurements are worth stating.** `-memory.allowedBytes` did not reduce
  memory held at all — `vm_cache_size_bytes` stayed at ~123 MiB, because
  VictoriaMetrics enforces internal floors those caches never drop below. It
  lowered the sum of cache *ceilings* from ~530 MiB to ~361 MiB, which bounds
  the worst case and nothing else. And `GOMEMLIMIT` was first set to 256Mi,
  which combined with 126 MiB of off-heap fastcache put the backstop at 382 MiB
  — effectively at the OOM point, where the kernel always wins first. RSS
  climbed back to the pre-change baseline within two hours. It is now **192Mi**,
  derived from the measured off-heap total rather than a predicted one. Whether
  that holds is unverified: the failure has a 1.6–3.6 day period, so only days
  of samples can confirm it.
- **Some OOM kills were invisible to the platform.** The kubelet reports a
  cgroup OOM *group* kill as `{exitCode: 137, reason: "Error"}`, not
  `OOMKilled` — a sweep for the latter across every production namespace
  returned zero results while the monitoring pod was being killed every two
  days. Six modules classified terminations and four disagreed:
  `node-health/memory-events` already inferred it correctly, `operator-error`
  matched the rendered text, and the per-tenant OOM alert scan plus three
  deployment-status paths matched only the literal — so a tenant container
  killed this way raised no alert and showed as a generic crash loop instead of
  the actionable "raise the memory limit". All six now share
  `lib/container-termination.ts`, with `ci-oom-classification-check.sh` failing
  the build on a new bare comparison, including the narrowed
  `terminated?: { reason?: string }` type that lets the check compile but never
  fire.

## [2026.8.22] - 2026-08-30

### Security
- **Any unauthenticated request could take every site on the cluster offline.**
  A single 600 MB `POST` to `/api/v1/auth/login` — no account, no token, no
  tenant — OOM-killed the Traefik pod in about three seconds (`exitCode 137,
  reason OOMKilled`), and with it every ingress on the cluster. The cause is in
  the ModSecurity plugin: it calls `io.ReadAll(req.Body)` into memory before any
  rule runs, so the WAF's own `SecRequestBodyLimit` never gets a say — the body
  is already resident. The plugin exposes no cap of its own; `maxBodySize` looks
  like a setting but is not a field on its config struct, so setting it is
  silently ignored.

  A Traefik `buffering` middleware (`maxRequestBodyBytes: 13107200`) is now
  attached **ahead of** the WAF on every route that carries it, so an oversized
  body is refused with **413** at the proxy and never reaches the plugin.
  Verified live: 600 MB now returns 413 in 0.33 s with no Traefik restart.
  `ci-waf-body-limit-check.sh` fails the build if the WAF is ever attached
  without the cap, or ordered after it.

### Fixed
- **Every file-manager upload and download had been failing with 403 since
  2026-08-12.** The sidecar's per-tenant auth gate expects an
  `X-Platform-Internal` header, and only the *buffered* apiserver-proxy path
  sent it — the three streaming direct-ClusterIP branches did not. Because the
  buffered operations (listing, rename, delete, small edits) kept working, the
  panel looked healthy and only the large transfers failed. All direct calls now
  go through one `directHeaders()` helper, and
  `ci-file-manager-auth-check.sh` fails the build on any direct `http.request()`
  that bypasses it.
- **Replacing a file via chunked upload could silently produce a corrupt
  archive.** The writer opened the destination for update and wrote each chunk at
  its offset but never truncated, so replacing a large zip with a smaller one
  left the previous file's tail in place. The result still opened, still listed
  entries, and extracted the *old* archive's trailing content — the worst kind of
  failure, because nothing reports an error. The final length is now passed with
  the last chunk and the file is truncated to it.
- **Tenant disk usage read "0 B of 0 B" on every Longhorn volume.** The `df`
  parser indexed fixed columns from the left, which breaks the moment the device
  path is long enough for `df` to wrap the row onto two lines — as every Longhorn
  device path is. It now indexes the five trailing columns from the right, which
  holds whether or not the row wraps.
- **`:latest` and other moving tags showed "unknown" update status forever.**
  The audit writer stored a sentinel row with a `NULL` digest and, once the
  digest resolved, tried to *update* that row — but a unique index over
  `(deployment_id, image, digest)` with `NULLS NOT DISTINCT` meant several
  sentinels could not coexist, and the update spanned more than one row and
  aborted. Nothing was ever recorded, so every later comparison had nothing to
  compare against. This is the fourth report of this symptom; the previous three
  fixes all changed comparison logic *downstream* of data that was never being
  written. Resolution now inserts the `(deployment, digest)` pair directly,
  treats a unique violation as "already audited", and deletes the sentinel
  afterwards. Migration `0091` collapses the duplicate sentinels left behind.
- **Image-audit rows grew without bound.** Every check appended a row per
  deployment, forever. Retention now keeps 90 days plus, permanently, the first
  recorded row per `(deployment_id, image)` — so the "first seen" baseline that
  update detection depends on is never reaped.
- **The per-application disk bar was measured against a hardcoded 10 GB.** An app
  using 6 GB showed an orange 60 % "warning" bar regardless of the tenant's
  actual storage limit. It now divides by the tenant's real limit.
- **A slow build could roll the DEV cluster backwards.** `build-deploy` pins
  images at the *end* of a run, so a 90-minute build finishing after two later
  merges wrote its own older images over the newer pin — silently reverting DEV
  by three merges. The workflow now checks whether its pin is an ancestor of the
  current one and skips the write if so. The guard fails open: an
  indeterminate ancestry check proceeds rather than blocking a deploy.

### Changed
- **Usage bars follow one threshold policy everywhere.** Four different schemes
  were in use across the dashboard, the resource-usage page, the tenant list and
  the per-app view — plus two invented denominators. All of them now come from a
  single shared module (warning at 80 %, critical at 100 %), and every tile
  reports **used / reserved / available** the way the resource-usage modal
  already did.
- **File-manager uploads bypass the WAF.** Inspecting an archive upload byte by
  byte buys nothing — the payload is opaque to request-body rules — while
  buffering it costs the proxy its memory. The upload path is carved out by a
  higher-priority route. The carve-out is now part of the reconciler's drift
  comparison; it shares a host and backend with the main route, which made it
  invisible to the old comparison and meant it was never actually applied.

### Added
- **Scheduled backups no longer notify tenants.** A tenant sees notifications for
  the backups they start; the platform's own scheduled runs are the operator's
  business and no longer appear in the tenant panel — success or failure.
  Failures still reach admins.
- **Restore carts are resumable, deletable, and reaped after 7 days.** An
  abandoned cart used to sit in the tenant panel with no way to reopen or remove
  it. Clicking one now reopens it, it can be deleted (409 while a restore is
  actually executing), and stale carts expire on their own.
- **Admin tenant backups are grouped by tenant, with a measured repository
  size.** Each tenant is a collapsible row listing its backups and any open
  restore carts with Resume and Delete. The size column previously showed bytes
  processed by the most recent snapshot, which is not a repository size at all;
  a refresh button now runs `restic stats --mode raw-data` and reports the real
  figure per component, leaving the cached value untouched if a component fails
  rather than reporting a confident zero.
- **A Login action on the admin tenants list**, so an operator can enter a
  tenant's panel without first opening the tenant.

## [2026.8.21] - 2026-08-27

### Added
- **The admin panel now reports a node that has never converged, instead of
  calling it "not reported yet".** A node whose `platform-ops-host-config.timer`
  was never installed relays a snapshot with no host-migration state — forever.
  The Host migrations card read that as *"No node has reported yet. Nodes
  publish after their next converge (hourly)"*, i.e. it told the operator to
  wait for something that was never going to happen. That is how the production
  cluster sat two weeks and 17 releases with an **empty** migration ledger while
  every page showed green, missing among others the traefik
  `wait-for-plugin-registry` fix for its own 2026-08-20 outage.

  Such a node is now marked **never converged**, counts as degraded, opens
  itself, and prints the exact root-shell commands that repair it — there is
  deliberately no button, because the reporting agent is observe-only (read-only
  mounts, all capabilities dropped) and cannot write a systemd unit. Nodes the
  reconciler does not cover at all are also listed now rather than silently
  omitted, since an absent row is the one thing nobody notices.

  Both states are gated on a **2-hour grace window** derived from the node's own
  age, so a freshly joined node inside its first hourly converge stays quiet —
  the original relay treated all "no data" as benign precisely to avoid crying
  wolf, which was the right instinct and the wrong conclusion.

### Fixed
- **Bootstrap now always installs the platform-ops timers, even when the
  binary is already current.** `phase_platform_ops` short-circuited on
  "already at the target version" and returned *before*
  `platform_ops_install_timer` — but a current binary says nothing about
  whether its systemd units exist. With `insula bootstrap` (ADR-055) the
  operator puts the signed binary at `/usr/local/bin/insula` **before**
  bootstrap runs, so that branch is taken on the very *first* install and the
  units were never laid down. Two silent consequences on any cluster
  installed that way: the CLI never self-upgrades (the production cluster sat
  on 2026.8.3 for two weeks and 17 releases), and
  `platform-ops-host-config.timer` never exists — so **no host-migration ever
  runs**, leaving an empty `/var/lib/insula/host-migrations` ledger and
  host-side drift that nothing reports. On the affected production cluster
  that included the traefik `wait-for-plugin-registry` init container, i.e.
  the fix for the 2026-08-20 outage. Both unit writes and `systemctl enable
  --now` are idempotent, so they now run on every pass and a node whose units
  were removed self-heals. Regression asserted in
  `test-platform-ops-install.sh` (verified failing without the fix).

  **Existing clusters do not self-heal** — the missing timer is exactly what
  would have repaired it. Re-run bootstrap on the node to install the units;
  the first converge then applies every pending host-migration at once.

## [2026.8.20] - 2026-08-27

### Fixed
- **Flux stopped reconciling entirely on clusters that ran the 2026.8.18
  converger more than once.** The `0001-flux-strip-dr-cronjob-suspend`
  host-migration decided "is my patch already applied?" by grepping
  `kubectl get -o json` output for `"name":"<cronjob>"`. kubectl
  **pretty-prints** — its output has a space after the colon — so that test
  could never match, and `platform-ops host-config` appended a fresh copy of
  all three strip patches on **every enforce pass**. Once a second copy
  existed, kustomize failed the duplicate `remove` with `error in remove for
  path: '/spec/suspend': Unable to remove nonexistent key`, which pins the
  whole `flux-system/platform` Kustomization at `Ready=False` — so *nothing*
  reconciled, not just the DR CronJobs. Found on staging 2026-08-27 with three
  duplicates per CronJob. The migration now reads its state with
  `-o jsonpath` (values come back unquoted, with no whitespace to get wrong),
  matches with `grep -qx`, and removes any duplicates a previous run left
  behind, so an affected cluster self-heals on the next pass. A new CI guard
  (`ci-no-json-text-grep.sh`) rejects `"key":"value"` greps against kubectl
  output anywhere in the convergers, scoped to kubectl because `helm -o json`
  and HTTP/JMAP responses are compact and correct to match that way.

## [2026.8.19] - 2026-08-27

### Fixed
- **A hung API probe no longer defeats the login readiness gate.** The gate
  classifies a failed `/auth/oidc/status` probe as "API unreachable", but a
  probe that never *settles* — a TCP connect to a backend that accepts and
  then goes silent, or an edge whose own connect timeout is 60s — left the
  hook in its `loading` state, which renders the login form. That is exactly
  the dead form the gate exists to prevent, reached from the other direction.
  Probes now carry an 8s abort budget and an aborted probe counts as
  unreachable; the controller is also aborted on unmount so a navigation away
  cannot leave a request dangling. Fast failures (an endpoint-less upstream
  answers 502 immediately) are unaffected.
- **The login page no longer offers a sign-in form the API cannot honour.**
  Both panels already fetched `/auth/oidc/status` on mount — they need the
  provider list — but caught every failure and fell back to
  `{ localAuthEnabled: true, providers: [] }`, rendering a normal-looking
  password form whenever the API was unreachable. After a node restart that
  window is real: measured on production 2026-08-27, admin-panel was Ready at
  10:21:40 and platform-api at 10:24:01, so for **2m21s** the only way to
  discover the API was down was to type credentials and get an error. The same
  fallback was also wrong on OIDC-only clusters — `providers: []` hides every
  SSO button and suppresses the auto-redirect, leaving a local password form
  that can never succeed and does not self-correct once the API returns. The
  panels now distinguish "the API answered" from "nothing answered": on
  502/503/504 or a network error they show **"Waiting for the platform API…"**
  with an elapsed timer and a Retry button, re-probing with capped exponential
  backoff (~18 requests over that whole window, stopping on first success), and
  render the real form the instant it responds. Any other status still falls
  back permissively so a misconfigured edge gate cannot lock an operator out,
  and break-glass (`?emergency=true`) bypasses the gate entirely. No new
  request is added on the healthy path.
- **Node reboots no longer rip Longhorn volumes away from running pods.**
  `k3s.service` ships `KillMode=process` and orders itself only
  `After=network-online.target`, so on shutdown systemd stopped the k3s
  process while every container kept running, then tore down `iscsid` and
  the network underneath them. The kernel force-offlined the devices and
  the filesystem on top was cut away mid-write — on production 2026-08-27
  that produced `EXT4-fs error (device sdc): comm postgres: Detected
  aborted journal` on the CNPG `system-db` volume (Postgres WAL replay
  recovered it; that is luck, not a design). It also stalled shutdown for
  **3m28s** waiting out I/O timeouts, about half of a ~6m50s reboot
  outage. Nodes now run kubelet **graceful node shutdown**, draining pods
  in an order that matches the platform's PriorityClasses — tenants
  (`0`, 30s), then platform services including Postgres (`platform-critical`
  10000, 40s), then the **Longhorn data plane** (`longhorn-critical`
  1000000000, 30s), then `system-*` (20s). That ordering is the whole
  point: a first attempt used the simpler `shutdownGracePeriod` pair,
  which puts Longhorn's `instance-manager` and CSI plugin in the *same*
  group as the database whose volume they have to unmount, and a real DEV
  reboot showed the unmount failing with `context deadline exceeded` on
  the `system-db-1` PVC — the corruption path still open.
  `shutdownGracePeriodByPodPriority` has no command-line flag (it is
  `KubeletConfiguration`-only, so `--kubelet-arg` cannot express it), so it
  ships as a `kubelet.conf.d` drop-in, alongside a logind
  `InhibitDelayMaxSec` drop-in and `After=iscsid.service` on the k3s unit.
  The logind file is named `zz-…` deliberately: systemd merges `.conf.d`
  drop-ins by filename across `/etc`, `/run` **and** `/usr/lib`, and
  `unattended-upgrades` ships one pinning the delay to 30s that outranks
  any digit-prefixed name — which is also why kubelet's own self-healing
  `99-kubelet.conf` never worked. Fresh installs get it from
  `bootstrap.sh`; existing clusters converge via host-migration
  `2026.8.19/0001-graceful-node-shutdown`.
- **A rebooted single-node cluster comes back on its own.** Draining pods
  properly exposed a latent deadlock: because gracefully-terminated pods
  are recreated rather than restarted in place, `calico-typha` (a
  *Deployment*) had to be scheduled at boot — and could not be, because
  the node still carried `node.kubernetes.io/network-unavailable:NoSchedule`,
  which only a healthy `calico-node` clears, and `calico-node` refuses to
  start without a ready Typha. A real DEV reboot sat in that cycle with
  every workload `Pending` until the taint was removed by hand. Typha runs
  with `hostNetwork: true` and so needs no CNI; it now tolerates that taint
  via the Tigera `Installation` CR. Multi-node clusters were never exposed
  (Typha schedules on another node), which is exactly why a single-node
  reboot test was the one that found it.
- **The pin-lag guard no longer cries wolf after every release.** It
  counted the two `[skip ci]` sync commits that `release.yml` pushes back
  to `development` (platform/VERSION + CHANGELOG) as "code commits whose
  images should be pinned" — but a commit that skipped CI has no images
  by definition. Those two alone pushed the last built commit outside the
  guard's slack, so every PR opened after a release failed the check until
  some unrelated backend change happened to trigger a rebuild. Commits
  marked `[skip ci]` are now excluded.
- **The BREAKING-release auto-upgrade gate actually works now.** A release
  flagged `### BREAKING` is supposed to short-circuit auto-update so an
  operator applies it by hand — but `release.yml` never wrote the
  `breaking` field into the signed release manifest, so the version
  poller always recorded "not breaking" and the planner's
  `blocked-breaking` branch was unreachable. The gate had never fired
  since it shipped. The manifest now derives `breaking` from the released
  CHANGELOG section (the definition of record), and a new CI guard
  (`ci-breaking-release-gate-check.sh`) asserts all four links of the
  chain — cut-release → manifest → poller → planner — so it cannot come
  apart silently again. Clusters with auto-update **off** (the default)
  were never affected.

## [2026.8.18] - 2026-08-26

### Removed
- **The legacy backup target-"Activate" path is fully retired**
  (operator decision 2026-08-26). Removed: the Activate/Deactivate
  buttons on Remote Storage Targets and the "Active Backup Target" card
  on Settings → Storage; the `activate`/`deactivate`/Longhorn
  `backups`/`backup-now` API routes; the Longhorn credential/BackupTarget
  reconciler; and the legacy `etcd-snapshot`, `postgres-dump` and
  (long-inactive) `hostpath-snapshot` CronJobs — their replacements
  (`etcd-snap-via-shim`, CNPG base backups + WAL, the streaming snapshot
  pipeline) have been the live path for months. Migration 0090 clears
  any still-active row. Binding a target to a class on *Targets,
  Schedules & Retention* is the only routing step; the nightly DR
  CronJobs are fed from the SYSTEM-class binding by the shim bridge.
- **Longhorn volume-level backup jobs (`daily-backup`, `weekly-backup`)
  are retired** (operator decision 2026-08-26). Off-cluster protection
  is the 3-class shim pipeline — nightly tenant bundles, CNPG base
  backups + WAL, mail restic — which covers every restore path
  including destructive volume shrink (its rollback source is a
  files-only tenant bundle, not a Longhorn backup). The volume jobs
  required a Longhorn BackupTarget that the shim model never
  configures, so they failed every night while reporting Complete.
  Local `hourly-snap` snapshots and `daily-fstrim` remain; Flux prunes
  the two removed RecurringJobs from existing clusters automatically.

### Fixed
- **Flux no longer fights the DR-CronJob bridge over `spec.suspend`.**
  The bridged CronJobs (secrets bundle, cluster-state, audit) ship
  `suspend: true` in their manifests; Flux re-applied that on every sync,
  reverting the bridge's unsuspend within a minute. The Flux
  Kustomization now strips `/spec/suspend` from its apply input for the
  three (same pattern as the mail snapshot CronJob) — fresh installs get
  it from bootstrap, existing clusters via host-migration
  2026.8.18/0001.
- **Nightly DR CronJobs (secrets bundle, cluster-state dump, backup
  audit) now run on shim-configured clusters.** They were only ever
  unsuspended by the legacy target-"Activate" flow — a cluster
  configured purely through the 3-class backup assignments (the normal
  path) left them suspended forever, with no alert (the backup-health
  watcher only sees failed Jobs, and a suspended CronJob never creates
  one). A new bridge reconciler feeds them the shim's own S3 endpoint
  (works for every upstream, CIFS included) and manages their suspend
  state from the SYSTEM-class binding (the bridge is their sole owner —
  the legacy flow is removed in this same release).
- **Longhorn volume backups failing for lack of a backup target are no
  longer invisible.** On a shim-only cluster Longhorn's nightly
  recurring backups error on every volume ("backup target default is
  not available") while the job pod still reports Complete. The platform
  now raises a daily admin notification when recurring backup jobs
  exist with no Longhorn BackupTarget configured. (Longhorn is
  deliberately not auto-pointed at the shim — that is an explicit
  operator decision; see the admin manual.)
- **Scheduled tenant bundles now run on CIFS/SMB (and any other) backup
  targets.** The nightly tenant-bundle wave built its transport directly
  and only understood S3/SSH — on a CIFS-bound cluster every scheduled
  bundle threw `Unsupported storage type 'cifs'` while manual "Bundle
  now" worked (it routes through the backup shim). The scheduled path
  now uses the same shim-first store as every manual path. On top of
  that, a scheduled wave with failures now raises an **admin
  notification** instead of dying silently in pod logs.
- **Nightly system (Postgres) base backups actually fire after enabling
  them.** The CNPG `ScheduledBackup` object is created *suspended* by
  the no-target safety net; enabling scheduled base backups on the WAL
  Archive tab patched the schedule but never cleared the suspend flag,
  so the nightly base backup silently never ran. Enabling now asserts
  `suspend: false`, and a periodic reconciler re-converges the object
  from the saved settings (existing clusters self-heal within ~5 min of
  upgrading, no operator action needed).
- **The mail schedule's enable toggle is honored.** Disabling the mail
  schedule previously changed nothing (snapshots kept running whenever a
  mail target was bound) — including the automatic "pause during a
  target switch". A data migration keeps currently-snapshotting clusters
  enabled so nothing stops on upgrade.
- **Tenant-bundle schedule cron expressions are parsed in full.** The
  scheduler previously ignored the day-of-month/month/weekday fields (a
  weekly cron fired daily) and rejected `A-B` ranges outright (the
  schedule silently never fired). It now uses the same full 5-field
  matcher as the mail engine, and claims each fire window with a
  replica-safe update so HA clusters can't double-fire the fleet.
- **Workloads scaled to 0 by a storage operation always come back up.**
  Three recovery gaps closed: a failure *during* the scale-down itself
  now restores from the pre-persisted replica snapshot; the
  "clear failed state" valve now also scales the workloads back up; and
  a new 15-minute watchdog reaps operations abandoned by a platform-api
  restart and restores any tenant left quiesced with no operation in
  flight.
- **"Scheduled inclusion" panel is no longer empty when nobody is
  excluded** — it now lists every tenant with its resolved state and an
  in-place override editor (*Inherit plan* / *Always include* /
  *Exclude from schedule*). The old copy pointed at controls that did
  not exist.

### Changed
- **Backup tables are sortable and show exact times on hover.** Every
  backup/snapshot table in both panels (tenant snapshots + bundles, mail
  snapshots, system backup catalogue, system snapshot rollup, tenant
  detail) sorts by any column — defaulting to newest first — and
  hovering a relative "created" time shows the absolute timestamp.
- **Backups tab now comes before Snapshots** on the per-class backup
  pages, and the Snapshots tab states that snapshots are temporary
  (auto-reaped after the configured expiry, default 48 h) with a
  per-row **Expires** column.
- **Per-tenant backup history is visible.** The Backups tab shows
  per-tenant bundle counts (clickable filter chips), the tenant detail
  page links straight to a tenant's filtered bundle list, and the
  single-tenant trigger lists are sorted alphabetically.

### BREAKING
- **Longhorn volume-level backups are gone; off-cluster protection is now
  exclusively the 3-class backup pipeline.** If your cluster was on the
  legacy "Activate a target" path with a working Longhorn BackupTarget,
  its nightly `daily-backup`/`weekly-backup` volume backups stop with this
  release (Flux prunes the RecurringJobs) — existing Longhorn backups in
  your bucket are untouched and still restorable by Longhorn, but no new
  ones are taken. **Action:** confirm every class (`tenant`, `system`,
  `mail`) is bound to a target under *Backups → per class → Targets,
  Schedules & Retention*, and that the tenant-bundle schedule is enabled;
  that pipeline covers tenant data, Postgres (base + WAL), and mail. Local
  `hourly-snap` snapshots and destructive-shrink rollback are unaffected.
- **The legacy target-activate admin API is removed.** `POST
  /admin/backup-configs/:id/activate`, `.../deactivate`, `GET
  /admin/backup-configs/:id/backups` and `POST
  /admin/backup-configs/:id/backup-now` now return 404 — any operator
  script calling them must move to the class-assignment endpoint
  (`PUT /admin/backup-rclone-shim/assignments/:class`). The admin panel
  moved with them in the same release; migration 0090 clears the retired
  `active` flag on all target rows.

## [2026.8.17] - 2026-08-26

### Added
- **Mailbox aliases (with reply-as).** A mailbox can now carry extra
  addresses — `info@`, `postmaster@`, `webmaster@`, … — managed in the
  mailbox's Edit dialog. Mail to an alias is delivered straight into the
  mailbox (no separate forwarding account), and the mailbox owner can
  **send as** the alias: the mail server enforces alias ownership on
  submission, and webmail (Bulwark) offers the alias in the From selector
  automatically after the next login/identity sync. Disabling an alias
  stops both directions immediately. Enabled aliases and forwarding
  targets are shown in the email-account tables of both panels. Aliases
  never count against any plan quota, ride tenant bundles, and are
  re-converged automatically (boot + periodic sweep) after restores.

### Changed
- **"Aliases & Forwarding" is now "Mailing Lists."** The tab managed
  mailbox-less fan-out addresses (one address delivering to up to 20
  destinations) — that is a mailing list, and the new per-mailbox aliases
  made the old name actively confusing. Functionality is unchanged; the
  create button is now "Create Mailing List".
- **Suspending a tenant (or disabling a mailbox) now shuts its mail down
  completely** (operator decision 2026-08-26). Incoming mail — to the
  mailbox and to its aliases — is refused with a neutral bounce (nothing
  is silently stored or dropped, senders are informed), and the account
  cannot authenticate: no SMTP submission, IMAP/POP3, ManageSieve, or
  webmail sign-in until re-activation. Forwarding and auto-reply stop
  with it. Previously the platform-managed Sieve script kept redirecting
  a suspended tenant's mail and the account could still sign in and
  send. Reactivation restores everything from the stored configuration.
- **Tenant archive now destroys the Stalwart account principals** (after
  the destroy succeeds, never before) instead of deleting the platform
  rows and leaving live, unmanageable mailboxes behind on the mail server.
  The pre-archive tenant bundle remains the recovery path, matching the
  existing archive semantics for mailing lists.

### Fixed
- **Mail drift could go undetected between the platform DB and Stalwart.**
  A 2026-08-25 audit closed the class: the DB→Stalwart mail reconciles
  (mail rules, mailing lists + catch-alls, mailbox aliases) now also run
  on a 15-minute sweep instead of only at boot; orphaned Stalwart
  MailingLists (a live forwarding address no platform row owns) are
  surfaced as a new `orphan-list` item on the Data Drift page with an
  operator-confirmed delete action; archive no longer deletes alias rows
  when the Stalwart-side destroy failed (it retries first); and restores
  no longer replay source-cluster Stalwart ids into the target DB —
  they are nulled on replay and re-resolved by the reconcilers.
- **App preview rendered sites without CSS/JS.** The panels' own nginx
  asset-cache rule (a regex `location` for `.css/.js/.png/…`) outranked the
  plain `/api/` proxy prefix, so every preview-proxied asset path (e.g.
  `/api/v1/preview/<token>/styles.css`) was answered 404 by the panel
  instead of being forwarded — pages loaded, styling and scripts never did.
  The API locations now use `^~`, which suppresses regex evaluation. Routes
  were never affected (routed traffic bypasses the panel nginx entirely).

## [2026.8.16] - 2026-08-25

### Added
- **ntfy push notifications.** A new *ntfy* notification channel publishes
  platform events to an [ntfy](https://ntfy.sh) topic — public ntfy.sh or
  any self-hosted server, with private-topic support via access token or
  username/password (stored encrypted). Configure it under Platform →
  Notifications → Providers (with a one-click topic test), then enable the
  channel per Source. ntfy is a topic broadcast: one message per event,
  priority mapped from severity, with a tap-through link to the relevant
  admin page; deliveries are queued, retried with backoff, and visible in
  the Delivery Log (credential errors go straight to the dead-letter state
  instead of retry-spamming).
- **Preview a deployment before assigning a route.** Catalog apps and custom
  containers now have a **Preview** button next to Start/Stop (admin and
  tenant panels) that opens the running app in a sandboxed viewer via a
  short-lived proxy link — no domain, DNS, or ingress route needed. Multi-port
  deployments get a target picker. The preview is hard-sandboxed (server-sent
  `CSP: sandbox`, credentials stripped in both directions), so previewed app
  code can never touch the panel session; app logins inside the preview are
  disabled by design, and apps that assume they run at a domain root may
  render without styles — assign a route for full fidelity.

### Changed
- **Tenant-namespace NetworkPolicy `allow-platform-api` no longer pins
  ports** (was TCP/8111, file-manager only): the preview proxy reaches
  arbitrary workload Service ports. The peer selector stays pinned to the
  platform-api pod; platform-api already holds cluster-admin credentials,
  so the port pin bounded little — but this IS a deliberate widening of
  that rule. Existing tenant namespaces converge on the next platform-api
  start.
- **`insula operator-key rotate` — recover from a lost operator age key.**
  Mints a new keypair (old key files are preserved, never deleted), updates
  the cluster recipient, and immediately triggers a fresh secrets-bundle
  export so the newest off-site bundle is readable with the new key.
  Bundles exported before the rotation stay encrypted to the old key.
  `insula operator-key status` shows the cluster recipient and whether the
  key file on the host matches it. The DR → Secrets Bundle page and the
  operator manual now explain the loss-recovery path.
- **Bootstrap's completion summary now calls out the operator age key** —
  where it is, why it matters, how to copy it offline and remove it from
  the server (previously only mentioned in a log line thousands of lines
  earlier that had long scrolled away).
- **Pages refresh themselves when a backup task finishes.** Manual system,
  tenant and mail backup runs (and restores, snapshots, target switches)
  now invalidate the affected pages' data the moment the task center sees
  the task complete — no more manual reload to see the new backup.
- **Database-restart warning before enabling WAL streaming / base backups.**
  First-enable now asks for confirmation and explains the CNPG rolling
  restart (up to ~5 min; hosted websites and tenant databases unaffected).
- **Mail snapshots without an off-site target warn honestly.** Triggering a
  mail snapshot with no mail backup target assigned returns (and shows) a
  "stored on-cluster only" warning instead of looking identical to an
  uploaded snapshot.

### Fixed
- **Mail backups page no longer reports a scary "repo not reachable" right
  after assigning a target.** The restic credentials Secret is now
  materialised inline during target assignment (previously only a 5-minute
  reconcile tick created it, and the UI's list pod sat in
  `CreateContainerConfigError`). The provisioning window and a
  not-yet-initialized repository now each get an accurate message.
- **Mail snapshot count / repo size were stuck at 0/0 B.** The snapshot
  jobs' stats-reporting token Secret (`platform-api-sa-token`) was
  referenced by the manifests but never created by anything; the
  mail-restic reconciler now owns it, so completed snapshots report their
  stats to the overview.
- **Cluster → Storage no longer claims "no backup target" when class
  targets are assigned.** The card now shows the three backup-class
  assignments and scopes the "Active" target to what it actually drives:
  Longhorn volume-level backups.
- Assigning a backup target now refreshes the backup pages' target/status
  panels immediately instead of requiring a reload.

## [2026.8.15] - 2026-08-24

### Added
- **Email aliases now actually deliver.** The "Aliases & Forwarding" tab has
  been wired to the mail server (rows were previously stored but never
  provisioned, so alias mail bounced as unknown-recipient): an alias delivers
  to up to 20 destinations — local mailboxes or external addresses —
  and can be edited or temporarily disabled from a new edit dialog matching
  the mailbox UX. Disabled aliases reject mail instead of silently accepting.
- **The domain catch-all works.** The catch-all address on Settings & DNS is
  now enforced by the mail server; clearing it returns unknown names to being
  rejected.

### Fixed
- **Mailbox storage usage ("used") was always 0.** The usage sync still
  called an API removed with the mail-server 0.16 upgrade (with mismatched
  credentials on top) — every request failed silently. It now reads the live
  per-account disk usage in a single query; the mailbox list shows real
  numbers within one sync interval.

## [2026.8.14] - 2026-08-24

### Added
- **Auto-reply (vacation messages) now actually replies.** The mailbox
  edit dialog's auto-reply has been wired to the mail server (it was
  previously stored but never sent): each sender receives the reply once per
  vacation period, automated senders are never answered, and it composes with
  forwarding. Enabling auto-reply now requires a message body.

### Fixed
- **Tenants with more than one domain: every domain after the first served
  Traefik's self-signed default certificate — while the UI truthfully said
  the real certificate was issued.** Traefik only serves certificates that
  an IngressRoute actually references, and the tenant ingress referenced
  only the first domain's certificate Secret; the others sat issued but
  unreferenced. The reconciler now creates one IngressRoute per
  certificate, so every issued certificate is served (and cleans them up
  when a domain is removed).
- **Custom deployments using a moving tag (`:latest`, `:1.27`, `:24.04`)
  showed "unknown" in the Updates column forever.** The update checker
  compares the registry's digest against the digest the pods actually run,
  but the pod-observed record stores the image name as the container runtime
  reports it (`docker.io/library/nginx:latest`) while the check looked it up
  under the name you typed (`nginx:latest`) — so the running digest was never
  found. The lookup now matches canonical image references.

### Added
- **Send-only mail accounts.** A new account type for addresses like
  `no-reply@your-domain` that can authenticate and send via SMTP (app
  passwords) but have no inbox: nothing is stored, webmail and IMAP/POP3 are
  disabled, and incoming mail is bounced back to the sender with a clear
  notice. Pick **Send-only** in the mailbox create form.
- **Per-mailbox forwarding.** Any mail account can forward incoming mail to up
  to 20 addresses (edit dialog → **Forward incoming mail**). A normal mailbox
  forwards *and keeps a local copy*; a send-only account forwards *without
  storing anything*. Forwarding is enforced by the mail server itself
  (per-account Sieve script managed by the platform) and re-converged on every
  platform restart, so it survives mailbox recreation and restores.

### Fixed
- `./scripts/local.sh mail-up` no longer reports a spurious "Pod not ready
  within 3 minutes" — the readiness wait watched a label no Stalwart pod
  carries (and raced pod creation); it now waits on the Deployment.

## [2026.8.13] - 2026-08-23

### Added
- **Tenant apps can now reach the platform's own mail server, SFTP gateway, and
  web ingress.** A container you run on the platform (a PHP app sending mail via
  `mail.<apex>`, a job fetching one of your sites over HTTPS, a tool uploading
  files via SFTP to `files.<apex>`) previously could not connect to those
  services when its pod happened to land on the same node that serves them —
  which is *every* pod on a single-node cluster, and unpredictable on a
  multi-node one. Tenant workloads are now allowed to reach the mail
  (SMTP/submission/IMAP/sieve), SFTP, and HTTP(S) ingress services. These stay
  gated by their own authentication (mailbox login, SFTP credentials) and the
  web firewall, exactly as they are for connections from the public internet.

### Changed
- **Domain routes now use direct `A`/`AAAA` DNS records** pointing at the
  cluster's ingress address(es), instead of a per-route `CNAME` into an internal
  routing name. Simpler and human-readable; if the ingress addresses change, use
  **Refresh route DNS** on the domain to rewrite the records. New managed DNS
  records default to a **1-hour TTL**.
- On the **domain** and **route** detail pages, the name in the title bar is now
  a link that opens the live site in a new tab.

## [2026.8.12] - 2026-08-23

### Added
- **Custom container deployments now detect updates for moving image tags.** The
  **Updates** column previously showed "unknown" for almost every container,
  because it only understood three-part version tags (`1.27.3`) — `latest`,
  `alpine`, and two-part tags like `1.27` or `24.04` all fell through. It now
  falls back to comparing the registry's current digest for that exact tag
  against what the container is actually running: **up to date** when the tag
  hasn't moved, **update available** (click to re-pull) when the registry has
  re-published it. Version-numbered tags still show patch/minor/major upgrades.
- **A "Check for updates" button** on the Custom Containers tab re-checks every
  container against its registry immediately, bypassing the hourly cache.

## [2026.8.11] - 2026-08-23

### Added
- **Every in-app notification is now clickable and takes you where you act on
  it.** Selecting a notification in the bell dropdown marks it read and opens the
  relevant page: an SLO alert opens Monitoring, a node alert opens Cluster →
  Nodes, and a tenant-specific alert (OOM, resource saturation, bandwidth, a
  failed custom deployment) opens *that tenant's* page rather than the full list.
  Previously a notification told you something was wrong but gave you no way in.
- **Custom container deployments are checked for a reachable image at create
  time.** A reference that is merely well-formed but not actually pullable
  (wrong tag, non-existent repository) is caught up front — a missing image is
  rejected, an access-denied or transient registry error is surfaced as a
  warning — instead of failing silently after the deployment is accepted.

### Fixed
- **SLO alerts showed a raw metric number instead of a readable value.** An
  availability alert read `Current value: 0.03865979381443299` with no unit and
  no next step. Values now render in the metric's own terms — a percentage
  (`3.87%`), a duration (`620ms`, `1.1d`), or a plain count — and the
  availability rules' descriptions were rewritten in plain language with a
  pointer to where to look.
- **A failed custom deployment could restart forever on "Starting…" with no
  notification and no way to stop it.** Failure is now detected by restart count
  (independent of which instant the reconciler samples), the operator gets a
  notification naming the tenant, the deployment, and the reason, the tenant
  panel shows the diagnostic, and a Stop/Start control breaks the loop without
  deleting the deployment's configuration.
- **Memory-pressure and OOM notifications named nothing actionable.** Tenant
  container OOM-kills and evictions now name the tenant, pod, and container (with
  a "+N more" roll-up) and point to Node health → Memory events, instead of a
  bare count.
- **Eight in-app notification types dropped the diagnostic detail their email
  kept.** Backup failures, certificate-renewal failures, WAL-archive problems,
  security-hardening drift, and scheduled-task failures now carry the same
  error/reason text in the panel that the email always had.
- **An over-long notification de-duplication key could make a notification vanish
  silently.** The delivery row's `dedupe_key` is bounded; a caller that built a
  key longer than the limit made the insert throw, and the error was swallowed —
  the notification simply never appeared. Over-long keys are now clamped at the
  dispatch boundary, and plaintext in-app bodies no longer HTML-escape ordinary
  symbols (`=` was rendering as `&#x3D;`).
- **A tenant SFTP user confined to a sub-directory could see its own chroot
  folder name.** `rsync --list-only` against the jail root had its trailing slash
  stripped by path sanitisation, so the listing named the jail directory itself.
  This was a cosmetic disclosure of the confinement directory's basename, not an
  escape — the user could never leave or read outside the jail — and the listing
  is now scoped to the directory's contents.

## [2026.8.10] - 2026-08-21

### Fixed
- **With a www redirect configured, the non-canonical hostname answered plain
  HTTP with a 404 instead of redirecting.** The HTTP-side route builder computed
  the alternate hostname and then never emitted a route for it, so with
  "add www" a visitor typing `http://example.com` hit the ingress controller's
  unrouted 404 — while `http://www.example.com`, `https://example.com` and
  `https://www.example.com` all worked. Observed live on a production domain.
  The alternate host now gets its own HTTP route carrying the www-redirect
  rule, taking the visitor to the canonical HTTPS address in a single redirect.
- **A domain's HTTPS kept serving the ingress default certificate even after its
  certificate was issued.** The route's ingress resource is built when the route
  is created — while the domain is still unverified, so no certificate exists
  yet and the resource is built without a TLS reference. When the certificate
  arrived moments later, nothing revisited the resource: the certificate sat
  ready while visitors saw the ingress controller's self-signed default
  indefinitely. The moment a domain verifies, its ingress is now re-reconciled
  so the issued certificate is actually served. Found by the full integration
  suite: certificate Ready in 20 seconds, yet the endpoint still presenting the
  default certificate.
- **A new domain could wait up to an hour for its TLS certificate.** Certificate
  issuance is deliberately held back until a domain's DNS verifies, so the
  platform never asks a certificate authority for a name that cannot be proven.
  On the create path the certificate was requested *before* that first
  verification ran — so it was correctly skipped, the domain verified moments
  later, and nothing asked again. The only retry was the hourly verification
  sweep.

  The effect was the opposite of what the gate was for: a domain whose DNS was
  already correct sat without a certificate — and therefore without working
  HTTPS — until the next sweep. It now asks again the instant the domain
  verifies, which is within seconds of creation for correctly configured DNS.

  Found by the full integration suite against a real cluster, where a freshly
  created domain never received a certificate at all.
- **Container images shipped known-vulnerable base packages.** The Debian-based
  images installed packages but never applied the base image's pending security
  updates, so they shipped whatever the pinned base contained — indefinitely.
  Bumping the pin would not have helped: the pin already referenced the current
  published image, and Debian rebuilds those far less often than it publishes
  security fixes. The images carried a set of `util-linux` flaws (mount
  time-of-check/time-of-use races and a bypass allowing execution from
  filesystems mounted to forbid it) for which fixes had been available.

  It stayed hidden because the vulnerability gate only runs when an image is
  rebuilt, and these images change rarely — so the gate was silent on the main
  branch and only fired on a pull request that forced a full rebuild. The images
  now pick up security updates at build time; verified against the same gate,
  which goes from failing to reporting zero findings.
- **Verifying a domain issued its certificate but kept serving the placeholder.**
  The verify action — which the panels run automatically when a domain page is
  opened — requested the certificate but never updated the route to serve it,
  so the browser kept showing the ingress default certificate. To anyone
  watching, that was indistinguishable from the certificate never being
  requested. The route is now updated in the same step.

### Changed
- **Requesting a certificate re-issue now runs a fresh DNS verification first —
  before anything is touched.** Previously the re-issue deleted the existing,
  still-valid certificate and then placed a new order regardless of DNS state.
  Since a re-issue is clicked precisely when something seems broken, an operator
  with misconfigured DNS destroyed their working certificate and burned a doomed
  order against the certificate authority's weekly limit. Now: if the fresh
  check fails, the re-issue refuses, the existing certificate is left untouched,
  and the message explains what to fix. The check is live, not cached, so a
  just-fixed domain passes immediately.

## [2026.8.9] - 2026-08-21

### Fixed
- **DNS records written by the panel only appeared after a page reload.** Enabling
  or disabling mail, rotating a DKIM key, and creating, changing or deleting an
  ingress route or a domain all write DNS records on the server, but the panel
  never re-asked for the domain's DNS Records list afterwards — so it kept showing
  the copy it had fetched earlier. The records were on the DNS server and in the
  database the whole time; only the page was out of date.

  Reported twice — first for ingress-route records, then for mail records — before
  it was recognised as one systemic bug rather than two. An audit found the same
  omission in **18 places across both panels**; all are fixed, and a CI guard now
  fails the build if a DNS-writing action forgets to refresh the list.

  Certificate status was a separate case and already correct: the domain list
  polls while a certificate is issuing, so it settles on its own.
- **The whole platform shared one 100-request/minute budget for SFTP logins.**
  The API rate limiter keys on the authenticated user, falling back to the
  source IP. The sftp-gateway calls the platform machine-to-machine with no
  JWT, so every tenant's login keyed on the single gateway pod IP — roughly 25
  SFTP logins per minute for the entire platform (about four internal calls per
  session), after which logins failed with an error no tenant could see or act
  on. The limit never applied to an attacker: an unauthenticated caller is
  rejected by the shared-secret check before it, and SFTP credential
  brute-force is limited by the gateway itself, keyed on the real client IP.
  Per-file transfers were never affected — an upload of ten thousand small
  files makes about four API calls, not ten thousand.
- **Mail telemetry batches were silently dropped once the mail stack got busy.**
  The webhook receiver shared the same single-IP budget, so past 100 batches a
  minute events were rejected and the data simply went missing — a gap in
  operator-visible mail statistics that opened exactly when mail was busiest.
- **Backup and restore streaming could fail part-way through a bundle.** The
  internal artifact upload and download endpoints shared that budget too, so
  several tenants backing up or restoring at once could exhaust it mid-run. A
  bundle that loses a component is recorded as partial — a failure whose cause
  looks nothing like a rate limit.
- **A shared internal secret was compared in non-constant time.** Two mail
  endpoints checked their bearer token with a plain string comparison, while
  every other internal endpoint in the platform used a constant-time compare.
  The check now lives in one tested module rather than being copy-pasted per
  route.
- **The file manager could not save, upload, or open ordinary website files.**
  The web firewall inspected the file's own bytes as though they were request
  parameters, and refused them. On a platform for hosting websites, a tenant
  could not save `index.html` or `index.php`, could not upload a PHP file, and
  every raw upload failed regardless of content — the firewall rejected the
  upload's content type outright, so even a plain text file was refused.
  Reading a PHP file back was blocked too, as suspected source-code leakage.
  The panel showed a bare `403 Forbidden` with no usable message, because the
  request never reached the platform at all.

  The same bytes have always reached the same file over SFTP, which has no
  firewall in front of it — so the rules never prevented the content from being
  stored, they only blocked the panel while leaving the command-line path open.
  File content is now treated as what it is: opaque data being written to the
  tenant's own volume, never interpreted by the platform.

  The file's *destination path* keeps full firewall coverage — that is the
  field an attack would actually use — as does every other endpoint. Verified
  against a live cluster: path traversal and script injection in a file path,
  and injection on unrelated endpoints, are all still refused.
- **"Clean stale pod records" was not offered in the case that produces them.**
  The action was only suggested when a node had evictions or disk/memory
  pressure — a plain reboot causes neither, while routinely leaving Failed pods
  behind from jobs that fired before their dependencies were up. It is now
  suggested whenever the node actually has stale records, counted with the same
  predicate the cleanup uses so the count and the action cannot disagree.
- **The same action could not clean the platform's own namespace.** `platform`
  was outside the recovery allow-list, so the Failed pods a reboot most commonly
  leaves — the platform's scheduled jobs — had to be removed with `kubectl`.
  It is now included; only Failed/Evicted/Unknown records are ever selected,
  tenant namespaces stay refused, and the database instance pods that also live
  there remain protected.
- **The guard protecting database pods from the recovery actions never worked.**
  It matched a label the database operator does not set — verified against a live
  cluster, where no pod carried it — so it always passed. It was harmless only
  because the namespace holding the database was refused outright, which is no
  longer true. It now matches the labels actually in use, checked against a real
  cluster rather than a test fixture.

### Changed
- **The host-migration coverage guard now also fingerprints bootstrap's Helm
  values.** Traefik, cert-manager, sealed-secrets, Longhorn and CNPG are
  installed once at bootstrap, so a `--set` change reaches new installs only —
  yet the guard did not look at them and reported "unchanged" for a change
  existing clusters would never receive. Both the flags and the values files are
  covered, and the guard fails loudly rather than silently covering nothing. A
  value hidden behind a shell variable is covered too — one already existed and
  was escaping the fingerprint.
- Panel test suites resolve shared contracts from source instead of the built
  output, so a stale build can no longer surface as a confusing "not a function"
  failure that CI never reproduces.
- **Turning on a www redirect broke the route entirely** — neither the `www`
  nor the bare form worked. The non-canonical spelling was never routed at all
  (so it 404'd), and the redirect matched the address it was redirecting *to*,
  so the other one looped. Both spellings are now served, the redirect targets
  a fixed address so it cannot point at itself, and the certificate covers both
  names — previously it would have worked over `http://` and failed the TLS
  handshake over `https://`.
- **DNS records the platform created for a route never appeared in the
  panel**, though they existed at the DNS server — so the list said one thing
  and the internet said another, and removing a route could not clean them up.
  Records are now recorded as the platform creates them, and marked as
  platform-managed so a hand-made record is never touched by an automatic
  repair.
- **No IPv6 records on a dual-stack cluster.** The IPv6 address was read from a
  different place than the IPv4 one, so unless it had been set by hand no `AAAA`
  record was ever written. The same path also created a single address record
  instead of one per entry point, pinning every site to whichever came first.
- **Deleting a large selection in the File Manager failed partway** with "too
  many requests", leaving some files gone and no indication which. The whole
  selection is now one operation, and any items that could not be removed are
  listed while the rest still go.
- **Certificates took far longer than necessary to appear.** A domain becoming
  verified is what makes a certificate obtainable, but nothing acted on it — the
  request waited for a periodic sweep. Verifying now requests the certificate
  immediately.
- **Pages showed stale content until reloaded** — most visibly a certificate
  that stayed "pending" after it had been issued. Work that finishes in the
  background is now watched until it completes instead of being read once.

- New zones are created with a 14-day SOA expire instead of 7. Expire is how
  long a secondary keeps answering when it cannot reach the primary; at 7 days
  a long weekend outage can take a domain off the internet while a perfectly
  good copy of the zone sits on the secondary.

### Added
- **Refresh Route DNS** for Primary-mode domains, in both the tenant domain page
  and the admin Domains tab. Rewrites a domain's entry-point records from the
  current set — the repair for "a new server was added and existing sites don't
  use it". Subdomains already self-heal; the apex cannot, which is why this
  exists.

## [2026.8.8] - 2026-08-20

### Fixed
- **A node reboot could leave both panels serving a bare 404 indefinitely.**
  Traefik downloads its plugins from an external registry at process start; if
  that fetch fails it disables the whole plugin subsystem and keeps serving,
  dropping every route whose middleware is a plugin — which is both panels. The
  cluster looks perfect throughout: pods Ready, certificates valid, GitOps
  green. On a reboot the network is routinely not up yet when Traefik starts,
  and nothing self-heals, so it stayed broken until someone restarted the pod by
  hand. Traefik now waits for the registry before starting, and a guard recycles
  a pod that came up without plugins. A plugin cache is *not* a fix and was
  measured, not assumed — with both archives cached and no network, Traefik
  still calls the registry unconditionally.
- **Domain verification could not be re-run after a failure.** Results —
  including failures — cache for 24 hours, and neither panel asked for a fresh
  check, so fixing your DNS and clicking Verify returned the stale failure until
  the cache expired. The cache behaviour is now documented with the timestamp to
  check; the button still honours the cache, so use the routing tab's cache
  timestamp to tell a stale answer from a current one.

### Added
- **An alert for "the panel has no route"** — the 2026-08-20 outage was
  invisible to every existing signal because none of them measured whether a
  request for the panel hostname still matched a route. This probes that
  directly and names the affected hostname. It deliberately does not fire when
  the probe itself cannot run: a monitoring outage must not look like a site
  outage.
- **Upstream DNS is now an operator setting** (*Platform Settings → DNS
  Providers*). The platform previously had two different, invisible resolver
  paths — domain verification used cluster DNS while mail checks used their own
  hardcoded servers — so two lookups of the same name could disagree and neither
  could be inspected or changed. Choose the cluster's own resolver (shown, since
  a mesh VPN agent can rewrite it) or up to four explicit IPv4/IPv6 upstreams.
  **Test** probes candidates without saving them, so a blackholed resolver
  cannot be locked in.

## [2026.8.7] - 2026-08-20

### Fixed
- **Wildcard certificates never issued, and no object anywhere reported a
  failure.** `platform-api`'s ClusterRole could not `create` ClusterIssuers, so
  the platform migration that installs the DNS-01 issuers took a 403 and the
  migration registry HALTED on it. The issuer was therefore never created, and
  a Certificate that references a missing issuer produces no CertificateRequest,
  no Order and no Challenge — so there was no failing resource to inspect and no
  event to find. Every cluster was affected. The role now grants `create` on
  `clusterissuers` only (deliberately not `update`/`patch`/`delete`, and
  namespaced `issuers` stay read-only).
- **A halted migration registry was silent.** One failed migration blocks every
  later one indefinitely, and nothing surfaced it: no metric, no alert, no API.
  A halted or drifting registry now raises a critical alert that names the
  failing migration, and is readable at `GET /admin/platform/migrations`.
- **An upgrade reported success while its migrations were still stuck.** The
  progress modal treated "all Deployments rolled" as done, which is what let the
  issuer failure above ride out an upgrade unnoticed. Post-flight now has
  `migrations-converged` and `host-migrations-converged` gates and the modal
  will not report done while either is failing. Both fail closed — an unreadable
  registry is a failure, not a pass.
- **Host migrations could lag an upgrade by up to an hour.** The converge ran
  only on its own timer, so host state and platform state were briefly
  inconsistent after every self-upgrade. `platform-ops-update.service` now
  triggers the converge on completion (non-fatal, non-blocking). bootstrap
  writes that unit once at install time, so existing nodes are amended by host
  migration `2026.8.7/0001-converge-on-self-upgrade` rather than silently
  keeping the old behaviour — fresh installs get it from bootstrap.
- **Bootstrap died on every fresh install.** Backticked prose in a comment
  inside an *unquoted* systemd-unit heredoc was command substitution and was
  executed (`line 132: -: command not found`). Same class of defect as the
  nftables heredoc in 2026.8.x; `ci-heredoc-backtick-check.sh` covers it.

### Security
- **The VM integration harness copied the operator's local credential profile
  into every disposable test VM.** The run tarball swept up a gitignored
  environment file containing staging admin credentials and an SSH key, and
  exporting an empty override did not suppress the profile search. The tarball
  now excludes it and each run writes its own scoped profile, covered by
  `test-vmtier-profile-isolation.sh`.

### Added
- Platform-migration convergence metrics and the `/admin/platform/migrations`
  endpoint, plus a smoke-test assertion so a halted registry fails the
  post-deploy check.
- An end-to-end DNS-record suite that drives every tenant-reachable record type
  through the platform API against a real PowerDNS in the VM tier.
- CI guards `ci-platform-migration-rbac.sh` (a migration that touches a cluster
  resource must have the RBAC to do it — the guard fails if it finds nothing to
  check, so it cannot pass vacuously) and `test-vmtier-profile-isolation.sh`.

## [2026.8.6] - 2026-08-19

### Fixed
- **Most DNS record types were never written to the DNS server, and the panel
  reported success anyway.** Verified against a real PowerDNS 4.9: `MX` was
  rejected with `Not in expected format` even on the platform's own mail path
  (the target was never canonicalised), `SRV` and `CAA` could not be built at
  all (`weight`/`port` were absent from the provider input, and CAA needs
  `<flags> <tag> "<value>"`), and every mail record was published to
  `<apex>.<apex>.` because the zone was appended to names that were already
  fully qualified. All of it was invisible: one sync path logged a
  `console.warn` and the other had an empty `catch {}`, and the API answered
  `201 Created` regardless. Record writes now surface provider rejections as
  `DNS_PUBLISH_FAILED` and roll back the local row, so a record that appears
  in the list exists in the zone.
- **The same composition bug existed in every other DNS provider.** Hetzner and
  Route53 sent a bare hostname as an MX value; Cloudflare and ClouDNS never
  sent weight or port, so SRV could not be created, and double-counted an MX
  preference that was already in the content; BIND/rndc composed MX without the
  trailing dot. The two wire shapes — packed RDATA and separate numeric
  fields — now come from one shared module.
- **Sync Records could never reach all-green.** The comparison claimed in its
  own comment to strip trailing dots and only stripped quotes, so every
  CNAME/NS/MX row was a permanent conflict; `SOA` was compared at all despite
  the server rewriting its serial on every change. Both sides are now
  canonicalised through the same code that performs the writes, and `SOA` is
  excluded.
- **Ingress route DNS was written to the wrong servers.** Every route-creation
  path omitted the domain id, so it skipped the authority gate and fanned out
  to every configured server instead of the domain's own provider group —
  while the matching deletions were correctly scoped, leaving records no
  cleanup would ever remove.
- **Mail DNS reported itself provisioned when the server had refused it.** The
  `*_provisioned` flags were derived from zone ownership alone; a rejected
  write now counts as not-published and is logged with what was refused.
- **Every SLO alert was anonymous.** All 24 rules aggregated with a bare
  `max()`/`min()`/`sum()`, which collapses every series into one scalar and
  discards the labels that say *what* is broken — `cert-not-ready` evaluated
  to literally `1`. The evaluator then reduced the result to a single number
  without reading the labels it already had, and `alert_state` was keyed by
  rule alone, so there was nowhere to record that one certificate was failing
  and another was fine. Alerts are now tracked per affected object; the
  notification, the SLO page and a new **Affected** column all name it
  (`certificate=<name> namespace=<namespace>`, `node=<node>`, …). Two broken
  certificates are two alerts that resolve independently.
- **Certificates were ordered for domains that had not been verified.** Nothing
  filtered domain status, so creating a domain immediately requested a
  Let's Encrypt certificate. Such an order cannot validate, and every failure
  both raised a `cert-not-ready` alert nobody could action and consumed
  Let's Encrypt rate limits that are shared by *every* domain on the platform.
  Issuance now waits for verification and is triggered by it; an explicit
  operator reissue still forces it.
- **Password managers prompted on every admin and tenant page.** The header
  search box carried no `name`, `id` or `autocomplete`, which password
  managers treat as a username field on an origin with a saved login.

### Changed
- The reserved-hostname guard no longer rejects records whose *value* points at
  a platform hostname. It blocked the platform's own documented setups — an
  `MX` at the platform mail server, a `CNAME` at the ingress base domain —
  while preventing no attack: name resolution is not authorization, Traefik
  routes on the `Host` header, and every admin UI sits behind a mandatory auth
  gate. The check on a record's *own* name, and the guard that stops a tenant
  registering a reserved hostname as a domain, are unchanged.
- `SOA` is no longer offered when adding a DNS record: a zone has exactly one
  and the authoritative server owns it, including the serial.
- The tenant detail page's title bar now carries only **Login as Tenant**; every
  other action moved into an **Actions** menu, with destructive entries
  separated and tinted.

### Added
- DNS record forms collect the fields each type actually needs — priority for
  `MX`, priority/weight/port for `SRV` — and show the expected value format.
  Previously the forms offered twelve record types but collected only
  type/name/value/TTL, so several could not be created correctly at all.
- Destructive confirmation dialogs let you click the name you are asked to
  re-type to copy it.
- `scripts/integration-dns-powerdns.sh` drives every record type the tenant UI
  offers against a real PowerDNS, using only inputs that UI can produce, and
  reads each record back — including the auto-provisioned mail set (MX, SPF,
  DKIM, DMARC and the four autodiscovery SRVs) and the route records. Gated in
  CI. The mocked tests it supplements asserted the request body the platform
  *sent*, which is why they never noticed the server rejecting it.

## [2026.8.5] - 2026-08-17

### Fixed
- **Releases shipped `:latest` for six runtime images instead of the digests they
  claimed to pin.** `cut-release.sh` rewrites the production platform-config
  from `:latest` to the digest-pinned values `development` carries, prints
  `stamped 6 runtime-image digest pin(s)`, and then never staged the file — the
  release commit adds its files by name, so the stamp stayed in the working tree
  and the tag went out without it. v2026.8.1 through v2026.8.4 each carry **0**
  digest pins in `k8s/overlays/production/platform-config-patch.yaml` while
  `development` carries 8, so production resolved file-manager,
  rocksdb-secondary-checkpoint, tenant-backup-tools, migration-tools,
  claim-validator and node-terminal at pull time — mutable tags, in the one
  overlay whose purpose is that a signed release is reproducible.
  The test meant to cover this passed throughout because it asserted the file
  **on disk** after the cut, which is not what a tag carries; it now asserts the
  **committed** content and that the cut leaves nothing unstaged. This release is
  the first to actually carry the pins.

## [2026.8.4] - 2026-08-17

### Added
- **Wildcard routes and the wildcard certificates to serve them.** A tenant can
  now route `*.example.test` — and `*.shop.example.test`, at any depth — and the
  platform obtains a certificate that covers it. Neither half existed before:
  the domain-name validator rejected `*`, and the reconciler emitted
  ``Host(`*.example.test`)``, which Traefik v3 treats as an exact string and so
  matches nothing at all.
  Wildcards render as `HostRegexp` matching exactly ONE label, mirroring RFC 6125
  certificate semantics, and carry an explicit LOW priority. That priority is not
  cosmetic: Traefik derives priority from rule LENGTH by default, and the
  wildcard regexp is longer than ``Host(`webmail.example.test`)`` — so an
  unconstrained wildcard would have outranked the platform's own
  webmail/autodiscover Ingresses on a tenant's own domain and swallowed their
  traffic. Exact hostnames keep Traefik's default, so their behaviour is
  unchanged. Reserved-hostname enforcement became coverage-aware in the same
  move: `*.<apex>` answers for admin/mail/webmail without matching any of them
  literally, which a Set-membership check walks straight past.
- **The platform serves its own ACME DNS-01 solver (ADR-058).** Wildcard TLS had
  never worked on any cluster. Three of the five shipped DNS-01 ClusterIssuers —
  PowerDNS (the primary target), Hetzner, ClouDNS — referenced third-party
  cert-manager webhooks that bootstrap never installs, the PowerDNS one carrying
  a hardcoded `apiUrl` copied from its upstream README; the other two need
  credential Secrets nothing creates. The selector still answered
  `wildcardCapable: true`, cert-manager left the order Pending, and the status
  reconciler read "no Secret yet" as "still issuing" — so the failure was
  invisible end to end while the platform already held working write credentials
  for the same zone.
  platform-api now serves the solver itself as an aggregated API
  (`acme.insula.host`), publishing the challenge TXT through the same
  `DnsProviderAdapter` used for every other DNS write. One issuer per ACME
  environment replaces the per-provider matrix, so PowerDNS, BIND/rndc,
  Cloudflare, Route53, Hetzner and ClouDNS all get wildcards — as does any
  provider added later — and no DNS credential is ever copied into the
  `cert-manager` namespace. Authentication is mTLS against the cluster's
  requestheader CA plus an aggregator-asserted-user allowlist; if that CA cannot
  be read the webhook refuses to start, because this endpoint writes records
  into customer zones.
- **A TLS view that shows failures, and a button to retry.** `GET
  …/domains/:id/tls` returns cert-manager's live state for every certificate a
  domain owns — including the failure message — plus whether a wildcard is
  possible and, when it isn't, which of the three distinct causes applies.
  `POST …/tls/reissue` forces a fresh order (rate-limited to one per hour per
  domain, because Let's Encrypt caps duplicate certificates at 5 per week) and
  reports progress through the task centre. Both panels grew a Managed
  Certificates card and a `failed` TLS badge carrying the reason.
- **Certificate failures now reach someone.** Issuance state is classified from
  the Certificate CR itself and persisted, and a failure notifies both the tenant
  (`tls.certificate_failed` — their visitors see the warning, and the usual cause
  is DNS they control) and the operator (`admin.cert_issuance_failed`). A
  wildcard that keeps failing past a grace period falls back to per-hostname
  HTTP-01 certificates so sites keep serving valid TLS, raises
  `tls.certificate_fallback`, and switches back automatically once the wildcard
  succeeds.

### Fixed
- **Every hostname routed to a custom deployment answered 404.** The deployer
  creates a Service named `<workload>-<portName>` (`wildapp-http`); the ingress
  reconciler re-derived `<workload>` (`wildapp`) and handed that to Traefik,
  which logged `kubernetes service not found` once per reconcile and served
  nothing. The route, the certificate and the pods were all healthy, so the only
  symptom was a 404 on a site that had just deployed successfully. Both sides now
  derive the name from one shared function, with a test pinning them together.
- **bootstrap turned two failed downloads into misleading errors, minutes
  later.** `raw.githubusercontent.com` rate-limits per egress IP; a 429 on the
  tigera-operator manifest was discarded by `>/dev/null 2>&1 || true`, so nothing
  was applied and the install reported "Calico CRDs never registered" five
  minutes on — pointing the operator at a healthy operator that had never been
  deployed. The same pattern on the external-snapshotter CRDs surfaced a phase
  later as `no matches for kind "VolumeSnapshotClass"`. Both now fetch with
  backoff, name the HTTP status when they fail, and accept a pre-staged copy
  under `/var/lib/insula/cache/` (which also covers air-gapped installs).
- **The TLS-settings issuer an operator chose was read and then ignored** — it
  existed only to log that the selector disagreed with it. It is now an input to
  certificate issuance for tenant domains.
- **A wildcard + apex order could strip its own challenge.** Such an order puts
  two TXT values on one `_acme-challenge` name, and PowerDNS deletes by RRset —
  so cleaning up the first challenge removed the second while the CA was still
  reading it. The provider interface gained a value-scoped delete.
- **Protected-directory child routes bypassed the Traefik backtick guard**, and
  would have emitted a dead `Host()` rule for a wildcard host — silently dropping
  the basic-auth gate on that route.
- **A hostname could be issued against the wrong zone.** With both
  `example.test` and `a.example.test` registered, the reconciler picked whichever
  domain row came back first; it now takes the longest suffix match.
- **The mail bootstrap's one-shot Pods threw away their own output.** The
  Stalwart configure pod does the most intricate work in the whole install —
  listeners, DKIM, the ACME provider, the certificate order — and its logs never
  reached `/var/log/insula-bootstrap.log`. The transcript had a hole between
  "condition met" and the next step, which is how an ACME order that never
  succeeded looked exactly like a clean install.
  The cause is a property of the `kctl` wrapper worth writing down: it decides
  what to do with output by `[ -t 1 ]`. In **statement position on a TTY** it
  suppresses the output from the screen but records it to the transcript; when
  its stdout is a **pipe** (`kctl logs … | sed …`) or a **command substitution**
  (`x=$(kctl logs …)`) it passes straight through and records **nothing**. Every
  pod-log reader in the mail path used one of the two unrecorded forms, so the
  output existed only as text scrolling past on a terminal.
  New `capture_pod_logs` fetches a pod's logs once, calls `ui_record` explicitly
  so they survive in the transcript, and returns them for the caller to grep or
  print (`print_pod_logs`). All six call sites — master-user provision, the
  configure pod on both the success and timeout paths, and the ACME renewal pod
  — now route through it. The timeout path previously ran `kubectl logs` three
  times to ask three questions about the same output and recorded none of them;
  it now reads once. An empty log is recorded as `— EMPTY`, because "the
  container printed nothing" and "we never looked" are different findings.
  Asserted in `scripts/test-bootstrap-quiet-wrappers.sh` (18 checks, under a
  real pty via `script(1)` since the behaviour depends on `[ -t 1 ]`), including
  a guard that fails if any call site returns to the unrecorded forms.

### Added
- **Custom deployments can now pull the latest image and redeploy.** An
  **Update** control on every custom container and compose stack re-pulls each
  image at its *current* tag and rolls the pods — the `:latest`-moved and
  `:1.27`-rebuilt case, which is invisible to the existing "Updates available"
  pill (that compares tag *lists*, so a republished tag looks identical).
  Single-container deployments additionally get an **Auto** toggle: an hourly
  check that re-pulls automatically when the pinned tag's digest moves.
  Auto-update **never changes the tag** — a genuinely newer tag (1.27 → 1.28)
  stays a deliberate click on the pill, so automation cannot walk a tenant
  across a version boundary. Stacks are excluded by design: N services means N
  independent digests and no single "the image changed" event.
  If an auto-update pulls an image that never becomes Ready, the previous
  digest is restored (pinned as `repo@sha256:…`, because the tag now resolves
  to the broken image), auto-update is switched **off** so the next tick cannot
  repeat it, and the tenant is notified
  (`tenant.custom_deployment_rolled_back`).
  Deliberate safety property: "could not tell" is never treated as "it
  changed". An unreachable registry, a missing `Docker-Content-Digest` header,
  a malformed digest or a workload that has not yet reported one all mean
  *skip* — otherwise one bad hour at a registry would roll every auto-update
  workload on the platform, hourly.

### Fixed
- **`restart` on a custom deployment never actually restarted anything.**
  `PATCH {restart:true}` re-ran the deploy path, which strategic-merge-patches
  the Deployment with an identical pod template — a no-op to Kubernetes. No new
  ReplicaSet, no pod restart, and therefore no image re-pull however emphatic
  `imagePullPolicy: Always` was. Deploys now carry a roll marker from the spec
  (`rolledAt` → `insula.host/rolled-at` on the pod template), which is what
  forces the new ReplicaSet. It lives in the spec rather than being generated
  at deploy time on purpose: re-applying an unchanged spec (the DR redeploy
  path) must not restart a healthy workload.
- **The password manager stopped prompting on every admin/tenant page.** Panel
  routes were not code-split, so every page component was a static import in
  `App.tsx` and every page's markup — `Login`, `AdminUsers`, `OidcPage`,
  `RemoteStorageTargetsPage`, `SubUsers`, `Email`, `RouteDetail`,
  `PrivateRegistryPanel`, the provider settings pages — compiled into the single
  entry chunk that loads on **every** page view. Password managers detect those
  fields in the shipped bytes and offer autofill on each navigation, even for an
  operator who is already signed in. Conditional rendering does not help: the
  markup ships whether or not it ever reaches the DOM. Extracting
  `ChangePasswordModal` (2026-08-04) fixed one instance of the symptom; this
  fixes the cause. All 50 admin and 27 tenant page imports are now
  `React.lazy()` behind a `<Suspense>`, and the app-level `NodeTerminalHost`
  lazy-loads the node-terminal overlays that carry the `step-up-password` input.
  Admin entry chunk 2.5 MB → 680 kB, tenant → 312 kB, as a side effect.
  `titleCase` moved out of `NodeTerminalModal.tsx` into `node-terminal-utils.ts`:
  `BackgroundTerminalsDock` imported that one-line helper from the modal, and a
  module that is *also* statically imported anywhere stays in that importer's
  chunk (rolldown reports `INEFFECTIVE_DYNAMIC_IMPORT`) — so lazy-loading the
  modal did nothing until the leaf edge was cut.
  New CI guard `ci-no-password-fields-in-entry-chunk.sh`, wired into both panel
  workflows: it greps the real built chunks that `index.html` loads eagerly
  (entry script + every `modulepreload`) and fails if any contains a password
  input. Unit tests cannot see this class of bug — the assertion has to be on
  the shipped bytes. The guard also asserts password inputs still exist in
  *some* lazy chunk, so it cannot pass by finding nothing at all. It caught a
  case during development that a source grep had missed.

### Added
- **Mail-server health failures now raise a notification** (`admin.mail_health_degraded`,
  severity `error`, in-app + email, and any other channel the category is
  configured for). Previously the only mail signal that ever reached a
  notification channel was a DNSBL listing: health itself was computed *on
  demand* for the admin modal, and the periodic collector published two
  Prometheus gauges (`platform_mail_server_up`,
  `platform_mail_outbound_queue_depth`) and nothing else — the cert and
  deliverability findings were not in those gauges at all, so nothing periodic
  even evaluated them. A cluster could serve Stalwart's self-signed
  `SAN: localhost` certificate on 465/993, or have the pod down entirely, in
  silence. New `mail-admin/health-scheduler.ts` runs the same health assessment
  every 15 minutes (first pass 3 min after boot, so a cluster still finishing
  its first reconcile does not alert on components that are merely not up yet)
  and dispatches per failing component.
  Policy is deliberately narrow, because a noisy alert is an ignored alert:
  it fires only on components with `healthy === false`, never on
  `not_implemented` ("not configured" is not "broken") and never on
  warning-only findings — `probeDeliverability` keeps warnings healthy by
  design, so a missing AAAA stays visible in the UI and pages nobody. Each
  component deduplicates into a 12-hour bucket, so a sustained outage alerts
  twice a day per component rather than every pass. Clusters with no mail
  hostname configured are skipped entirely.
  Also adds `notifications/seed-consistency.test.ts`: categories and templates
  are seeded from two unconnected files, so a category shipped without a
  template would dispatch a notification that renders as nothing — arguably
  worse than none, because the alert now exists and says nothing. The guard is
  general, not specific to this category.

### Fixed
- **Mail TLS certificate was never issued on a fresh install — Stalwart served
  its built-in self-signed cert (`CN=rcgen self signed cert`, `SAN: localhost`)
  on 25/465/993 indefinitely.** `configure_stalwart_full` fires the JMAP
  `AcmeRenewal` task as its step 5c, from inside the configure pod — which runs
  *before* the Deployment roll that binds the listeners that same run created.
  `http-acme` on :80 is one of them, and it is what answers Let's Encrypt's
  HTTP-01 challenge via Traefik → `stalwart-mail-acme`. The order was therefore
  placed against a listener that was configured but not yet bound: LE could not
  validate, the order failed, and Stalwart does not retry until `renewBefore`
  (R23) — of a certificate that does not exist. Everything else was already
  correct (AcmeProvider registered with a real LE account, `Domain
  .certificateManagement = Automatic` with the right SAN, challenge path
  reachable from the internet), which is why the install looked clean.
  Diagnosed on a live fresh install by re-firing the identical task by hand
  after the roll — the cert issued in seconds with no config change.
  The order now runs after the roll, in `fire_stalwart_acme_renewal`, and
  bootstrap **verifies the served certificate actually carries the mail
  hostname** instead of assuming the task was enough; if it did not issue, the
  operator gets the exact `curl` to test the challenge path. Pure ordering fix —
  cert strategy, listener and Traefik path are unchanged.
- **A fresh install reserved 30% of the root disk for Longhorn — 150 GiB on a
  512 GB node.** The right-sizing rule (10% of capacity + 20 GiB, clamped to
  Longhorn's 30% so it can only ever reduce) existed *only* as host-migration
  `2026.8.2/0002`, and a migration converges an existing node on the hourly
  host-config timer — it cannot fix a default applied by the install that
  precedes it. Bootstrap now right-sizes the disk at install time via the same
  formula, so a new cluster never comes up with the wrong number. New
  `scripts/test-longhorn-reservation.sh` (31 checks) runs both implementations
  over a table of disk sizes and fails if they ever diverge — if they did, the
  value would flap on every converge. Verified on the affected node: 150.8 GiB →
  70.2 GiB, ~80 GiB returned.
- **Mail health reported a dual-stack cluster's own IPv6 address as "not a
  cluster server node".** `probeForwardDns` merges A and AAAA into one resolved
  set but compared it against `serverNodeIps`, which is IPv4-only — so every
  correctly published AAAA came back as an `extraIp`, on a cluster that was
  dual-stack end to end and whose Nodes page listed that exact address. The
  expected set now spans both families; `missingIps` stays IPv4-only because
  AAAA coverage is `probeIpv6Dns`'s finding and reporting it twice would
  double-count the same gap in the modal's rollup. A stray AAAA belonging to no
  mail node is still flagged, including on single-stack where the v6 probe is
  inert. It survived because every dual-stack test asserted on `ipv6Dns` and
  none checked what the *forward* probe did with the same AAAA — four
  regression tests added.

### Changed
- **A successful bootstrap now looks like one.** The completion report was built
  out of `log()`, which maps to `ui_detail`, which dims — so the one screen an
  operator reads start to finish rendered entirely in the grey reserved for
  incidental chatter, with the admin URL styled identically to a passing kubectl
  tip. It now has its own register: green banner, green section headings
  (`Endpoints`, `Admin sign-in`, `Installed`, `Consoles`, …) and undimmed body,
  via new `ui_banner` / `ui_section` / `ui_line` emitters. Body text uses the
  terminal's default foreground rather than an explicit white, which would be
  unreadable on a light background. The worker banner gets the same treatment —
  two completion banners rendered differently is worse than either choice made
  consistently.
- **The advisory post-install smoke no longer reads as a failed install.** It ran
  *after* the completion report and reported through `ui_warn`, so a run that
  installed perfectly signed off with two yellow warnings — `Smoke FAILED (rc=1)`
  and `Bootstrap exits 0 because --require-smoke-pass was not set` — as the last
  thing on screen. First-boot timing (Flux still reconciling, oauth2-proxy/dex
  restarting) trips a few checks on most installs, so this fired on healthy
  clusters. The phase now runs **before** the report (still after every mandatory
  step, so an outer timeout cannot skip real work) and hands it a verdict, shown
  as one factual line under *Post-install checks (advisory)* with the counts, why
  early failures are expected, and how to re-run. It raises **zero** warnings, so
  the run tally stops reporting phantom problems. The `--require-smoke-pass` gate
  is untouched: still a fatal `ERROR`, because the operator asked for a gate.
  New harness `scripts/test-bootstrap-summary.sh` (30 checks) pins the colour
  registers, the ordering, the zero-warning property and the gate.

### Fixed
- **Worker nodes never got the operator CLI, so they never applied a single
  host-migration.** `bootstrap.sh` called the platform-ops install phase only on
  the server branch, on the reasoning that `insula` is a control-plane operator
  tool. That was backwards: the timers that phase installs are what apply
  **host-migrations**, and a worker is a host like any other — same kernel knobs,
  same firewall shape, same packages. A worker came up with no binary, therefore
  no `platform-ops-host-config.timer`, therefore no convergence, and kept the
  host state it was born with for the entire life of a release. Silently — a
  timer that was never installed reports no failures. Observed on staging
  2026-08-11: three servers on `2026.8.3-rc.8` with `0003-pod-cidr-dns-firewall`
  applied and 2 nft rules; the worker still on `2026.8.2`, migration unapplied,
  0 rules. The whole worker-kubeconfig apparatus (`host-config-reader` DaemonSet
  + RBAC) existed to let `host-config apply` run on workers, and was dead weight
  without the binary that runs it. Both roles now route through one
  `install_platform_ops_cli` helper (a second copy of the VERSION-lookup drifting
  is how this was missed), the worker completion banner reports CLI + timer
  state, and `ci-host-config-check.sh` fails the build if the helper stops being
  called on both branches or grows a `NODE_ROLE` gate.
  **Existing workers need one idempotent `insula bootstrap … --join-as worker`
  re-run** — no host-migration can fix this, because the migration runner *is*
  the missing binary. See `docs/operations/MULTI_NODE_RUNBOOK.md`.
- Corrected `--role server|worker` → `--join-as server|worker` in the multi-node,
  deployment and node-role-taxonomy runbooks; `--role` is not a flag bootstrap
  accepts, so every copy-pasted join command failed at argument parsing.

### Security
- Bumped `pymdown-extensions` 10.21.3 → **11.0.1** (docs toolchain), closing
  `PYSEC-2026-3654` — exponential-backtracking ReDoS in the caret/tilde/betterem/
  magiclink inline processors (CVSS 7.5). Not reachable in any shipped artifact:
  the package appears only in `documentation/requirements*.txt`, consumed by the
  docs-site workflow, and we enable none of the four affected extensions. Held
  back from the 2026.8.3 cut because a major bump inside a stable release is
  gratuitous risk; verified here by building the manual with both pins and
  diffing the output — all 55 rendered pages are byte-identical. Lock regenerated
  with `--generate-hashes` (also picks up `charset-normalizer` 3.5.0 and
  `platformdirs` 4.11.2). Clears the red Component Watch gate.

## [2026.8.3] - 2026-08-12

### Fixed
- **A stale k3s installer checksum killed fresh installs with shell garbage
  instead of stopping.** Upstream re-published `get.k3s.io`, so the integrity
  guard fired correctly — but it reported through `error()` → `ui_fail()`, and in
  RICH mode every `ui_*` emitter prints to STDOUT by design. `fetch_verified_script`
  is unusual in that its stdout IS a payload piped into `sh`, so the
  human-readable failure text was captured by the caller and executed line by
  line (`sh: 2: url:: not found`, `sh: 8: Syntax error: "(" unexpected`). The
  guard that says "refusing to execute" printed noise and let the install carry
  on. Its failure paths now write to stderr and never touch the payload channel,
  every fetch call site refuses a zero-byte payload (piping "" into `sh` succeeds
  and installs nothing, which would look like a clean install), and the pin is
  updated to the current upstream installer — verified byte-identical to
  `k3s-io/k3s` `install.sh` before trusting it. New harness
  `test-bootstrap-installer-verify.sh` pins all of it, including a
  pin-freshness assertion so the next upstream re-publish shows up as one red
  test rather than a dead install.

### Fixed
- **Auto dual-stack must not decide on a JOIN.** Dual-stack is a cluster-wide
  property fixed by the first server's CIDRs; a joining node cannot change it
  and must match it, and registering a family the cluster doesn't have breaks
  kubelet registration. A joining node also holds a join token, not a
  kubeconfig, so it cannot discover the cluster's families beforehand — `auto`
  therefore keeps the historical IPv4-only default on any join, and matching a
  dual-stack cluster needs an explicit `--dual-stack`. Caught on staging, whose
  worker has routable global IPv6 while the cluster is IPv4-only: auto-enabling
  on host capability alone would have handed `k3s-agent --node-ip=<v4>,<v6>`
  against a single-family cluster.
- **The IPv6 reachability probe targeted a hostname that doesn't exist.**
  `ipv6.cloudflare.com` does not resolve, so the "second" target was dead weight
  and only the first was ever testing anything. Both targets are now anycast IP
  literals, which also stops the probe conflating "IPv6 routes" with "AAAA
  resolution works" — the question being asked is the former.

### Changed
- **`bootstrap.sh` now enables dual-stack automatically on a host with PROVABLY
  routable IPv6** (`--no-dual-stack` forces IPv4-only, `--dual-stack` still
  forces it on). Previously IPv6 was opt-in and easy to forget, and preflight
  could only warn about it after the fact.
  The gate is a reachability probe, not address detection: `ip -6 addr` cannot
  tell a working global address from a SLAAC/RA address whose prefix the
  provider never routed — they are byte-identical. The two mistakes are not
  symmetric. Forgetting the flag costs one flag on the next install; enabling on
  an unrouted address publishes an AAAA nothing answers on, which reaches
  `--node-external-ip`, then the `ingress-external-ips` reconciler copies it
  onto the Traefik Service, then tenant apex records — so IPv6-only clients fail
  outright and every dual-stack client eats a connect timeout first. And k3s
  fixes cluster/service CIDRs at install, so undoing it means re-bootstrapping
  the cluster. Same principle the mail AAAA path already encodes: a wrong AAAA
  is worse than no AAAA.
  A bound-but-unroutable address therefore installs IPv4-only, says so
  explicitly, and **holds for operator confirmation** so the routing can be
  fixed before committing to an irreversible CIDR choice. Holds are TTY-gated
  and skippable with `--yes`: `--remote` and CI never block (the remote path
  reads stdin itself, so a naive prompt would hang the install forever).
  Existing clusters are unaffected — CIDRs cannot change after install.

### Fixed
- **Worker nodes could never take a prerelease, so host-migrations in an RC
  silently never reached them.** `self-upgrade` reads the `platform-version`
  ConfigMap to learn the cluster's pinned version; on a k3s AGENT that read
  always failed, so it fell back to the "newest stable GitHub Release" path,
  which by construction cannot select an RC. Observed on staging: the worker
  sat on 2026.8.2 with no pod-CIDR `:53` firewall rule while all three
  control-plane nodes had rc.8 and the migration applied — host state diverged
  for the whole life of every RC, which meant nothing host-side was really
  validated before a stable cut. Two halves were broken and either alone still
  fails: the code hardcoded the control-plane-only `/etc/rancher/k3s/k3s.yaml`
  (agents don't have it, and the in-cluster fallback needs a ServiceAccount
  token a host process has no mount for), and the scoped worker kubeconfig had
  no RBAC for that ConfigMap — the existing Role is namespaced to
  `platform-system` while `platform-version` lives in `platform`. Resolution now
  goes through the same helper the host-config converger uses, and a second
  name-scoped Role grants `get` on that one ConfigMap (no list, no write,
  nothing else). An already-stuck worker still needs one explicit
  `insula self-upgrade --version <ver>` to cross over, since the fix ships in
  the binary it can't yet fetch.

### Fixed
- **Enabling email on a customer-managed (`cname`/`secondary`) domain reported
  four green provisioning ticks while nothing had been published.** The mail
  records were always written to `dns_records` — that part was right, and is
  what the domain's DNS page renders — but `mx/spf/dkim/dmarc_provisioned` were
  then set to `1` unconditionally, including in modes where the platform has no
  authority over the zone and pushed nothing anywhere. The operator saw a fully
  provisioned mail domain that could never receive mail. Those flags now mean
  what they say: they are set only when the records were actually published,
  and a customer-managed domain instead emits a warning naming the record count
  and pointing at the DNS Records page. Customer-managed DNS remains a
  supported mode, so this path still never throws.

### Added
- **The mail DELIVERY gate now runs as part of `integration-all.sh`.** It does
  an authenticated SMTPS send-to-self plus an IMAPS retrieve — the only check
  that proves mail actually delivers, since the TCP/banner probes are liveness
  only and pass while the server rejects at DATA with `452 mail system full`
  (the Stalwart regression that shipped undetected in v2026.6.14). It had
  skipped on every run because it needs a real mailbox and the suites' own
  mailboxes are deliberately ephemeral, so nothing was ever left for it to use.
  `scripts/lib/ensure-mail-e2e-mailbox.sh` now provisions a throwaway
  tenant + domain + mailbox, exports the credentials, and deletes the tenant
  afterwards. It honours a pre-set `MAIL_E2E_USER`/`MAIL_E2E_PASS` if you'd
  rather pin it to a mailbox you maintain, and degrades to the previous
  loud skip (never a hard failure) if provisioning can't complete.

### Added
- **Ingress addresses are now discovered from live cluster state.**
  `ingress_default_ipv4/ipv6` were operator-set and nothing kept them current,
  so adding an ingress-capable node updated Traefik's `externalIPs` (the
  `ingress-external-ips` CronJob already did that) while the DNS side silently
  kept the old set. A reconciler now lists nodes every 5 minutes — the same
  cadence and the *same* eligibility filter as that CronJob (Ready, has an
  ExternalIP, `ingress-mode != none`, `exposure != private`, missing labels
  meaning "include") — and records the result in `ingress_discovered_ipv4/ipv6`.
  Two deliberate constraints: it writes only the **discovered** keys, never the
  operator's, because an operator may point apexes at a load-balancer VIP that
  is no node's ExternalIP and a reconciler owning one key would undo that every
  tick; and it **refuses to publish an empty set**, so a transient API read or a
  cluster mid-upgrade cannot blank the addresses and make every apex look like
  it drifted to zero. Resolution order is override → discovered → env →
  `127.0.0.1`, and the effective source is surfaced in the drift report so
  "why is my apex pointing there?" is answerable from the UI.
  Clearing an override field now genuinely clears it, handing the field back to
  discovery — previously a saved value could never be un-set, and because the
  form is pre-filled with the effective address, saving an unrelated field would
  have frozen whatever was discovered at that moment into a permanent override.
  This still never writes tenant DNS: apex repair remains operator-invoked and
  additive.
- **Apex DNS drift detection and additive repair.** A tenant apex cannot CNAME
  into the ingress chain (CNAME is illegal at a zone apex), so its A/AAAA are
  *copies* of the cluster's ingress addresses living in the tenant zone. Add an
  ingress-capable node and every apex silently keeps pointing at the old set —
  subdomains follow the chain automatically, apexes do not.
  A scan compares each primary-mode zone's apex records against the configured
  ingress addresses and reports, per domain: what is **missing**, what is
  **present but not platform-managed**, and which zones could not be read at
  all (an unreadable zone is drift you cannot rule out, so it is reported
  rather than skipped).
  Detection is read-only and runs hourly plus on demand from **DNS Providers →
  Scan for drift**; it *never* repairs on its own. A banner appears only when
  there is drift or an unreadable zone — extra apex records alone never raise
  it, since they are usually deliberate. Repair is explicit, selectable per
  domain or all at once, runs through the task center with a per-domain
  progress checklist, and is strictly **additive**: missing ingress addresses
  are added and nothing is ever removed, so a deliberate CDN origin or legacy
  host survives untouched. Unreadable zones are not selectable — with the zone
  unreadable there is nothing safe to add.

### Fixed
- **Tenant domain creation provisioned a DNS zone in every mode, including
  `cname` — which silently shadowed the platform wildcard.** The
  "auto-provision DNS zone" block in `createDomain()` special-cased only
  `secondary`; everything else fell through to `createZone()`. So a
  customer-managed (`cname`) domain still got a zone on the platform's own DNS
  servers. That is not merely useless: creating `x.<apex>` as a child zone
  makes the name EXIST, and per RFC 4592 a wildcard never covers a name that
  exists — so the platform's own `*.<apex>` stopped resolving for that host.
  The correct predicate already existed and was already used to gate record
  CRUD (`dns-servers/authority.ts:canManageDnsZone()`); `createDomain` just
  never called it, which is why records were correctly skipped in cname mode
  while the zone was created anyway. Both agree now.
- **Every provisioned zone was a lame delegation.** The PowerDNS provider
  hardcoded `nameservers: ["ns1.<zone>", "ns2.<zone>"]` — the zone's own name
  with a label glued on. Those hostnames are never registered and get no glue,
  so the zone was authoritative-looking and resolvable by nobody. The apex NS
  set now comes from the domain's provider group, and creating a zone with an
  empty NS list is refused outright (with an `OperatorError` pointing at the
  group) rather than minting a broken zone.
- **A provider group listing the same nameserver twice broke zone creation
  silently.** PowerDNS rejects an RRset containing duplicate records with 422,
  so the `replaceNsRecords()` fix-up failed — into a swallowed `console.warn`,
  leaving the placeholder NS in place. Duplicate nameserver hostnames and
  duplicate DNS-server names within a group are now rejected at the API with a
  clear error, blocked in the admin UI before submit, and de-duplicated
  defensively at the provider.
- **Ingress routes wrote an A record for subdomains instead of a CNAME.** The
  old code took the "always create A, simpler, no CNAME limitations" route,
  which pinned every tenant subdomain to one hardcoded IP and made adding an
  ingress node a manual per-domain DNS migration. Subdomains now CNAME to
  `<slug>.ingress.<apex>` — the indirection the CNAME chain exists for, so node
  membership changes are one central RRset edit. Apexes (where CNAME is
  illegal) get A/AAAA records and now support MULTIPLE ingress addresses so a
  multi-node cluster round-robins.
- **The loopback fallback could be published into a customer's zone.**
  `getIngressSettings()` falls back to `127.0.0.1` when `ingress_default_ipv4`
  is unset (a local-DinD convenience); that value was written verbatim as an
  apex A record. Loopback and unspecified addresses are now filtered out, and a
  route whose zone would get no address records says so in the log.
- **DNS provisioning failures were invisible.** Three bare `catch {}` blocks
  (zone creation, initial record sync, ingress-route record creation) discarded
  the error entirely — no status, no message. They are still non-blocking, but
  they now log what failed and where.
- **The host firewall blocked CoreDNS from reaching the node's own resolver,
  breaking ALL pod DNS.** The input chain exempted the pod CIDR for the
  control-plane ports but never for `:53`. That is dormant while the node's
  `/etc/resolv.conf` lists real upstreams — but a mesh client can own that file:
  NetBird rewrites it to its OWN interface address on hosts with neither
  `resolvconf` nor `systemd-resolved` to integrate with (where either is present
  it only appends its search domain and leaves the nameservers alone, which is
  why most nodes never saw this). CoreDNS runs `dnsPolicy: Default` and forwards
  what it cannot answer to that file, so its upstream queries arrived at INPUT
  with a POD source IP and fell through to the catch-all drop.
  The failure is total rather than slow: pods also inherit the mesh search
  domain, so any in-pod `getaddrinfo` for a name with fewer dots than `ndots`
  tries `<name>.<mesh-domain>` FIRST, that query blackholes, and glibc aborts the
  whole search with `EAI_AGAIN` — it walks past NXDOMAIN, but not past a
  timeout. platform-api then crashlooped in `wait-for-db` (3s connect timeout,
  240s budget) against a perfectly healthy Postgres, which is what the incident
  looked like from the outside.
  Latent by construction: `resolv.conf` is snapshotted into a pod at CREATION,
  so already-running CoreDNS pods keep the pre-mesh upstream and the cluster
  stays healthy until something recreates them — a k3s restart re-applying its
  packaged `coredns.yaml` is enough, and is what finally detonated it days after
  the mesh was installed. Host-migration `0003-pod-cidr-dns-firewall` backfills
  existing clusters; it derives the pod CIDR from the node's own ruleset rather
  than assuming the default, and inserts BEFORE the catch-all drop (an appended
  accept is unreachable).
- **A scheduler tick could still kill platform-api on a DB blip.** Third path to
  the same outcome, and the one that survived the pg-boss / `pg.Pool` fix: ticks
  were launched as `void runTick(...)`, and the `void` operator DISCARDS the
  promise, so a rejection inside had no handler and Node terminated the process.
  Not covered by the `'error'` listeners — those catch emitted EventEmitter
  events, this is an unhandled rejection, and auditing for one does not find the
  other. The tick was not unguarded either: it wrapped its Kubernetes read in
  try/catch, and the DB query further down is what rejected. Six periodic
  schedulers now run through `shared/safe-tick.ts`, which also catches a tick
  that throws synchronously (where no promise exists and a bare `.catch()` would
  miss it). Consequence beyond the crash: schedulers own in-process work, so a
  mid-flight death strands rows only that process would have finalised — this is
  why a COMPLETED PITR left no task chip.
- **Mail port exposure now defaults to `activeNodeOnly`.** `allServerNodes` runs
  the HAProxy DaemonSet and requires ≥2 server nodes; the API refuses it below
  that. Every install starts as a single node, so the old default stored a mode
  the cluster could never realise — no HAProxy DaemonSet was ever created — and
  it was a one-way door: once anything moved the value to a legal mode, nothing
  could set it back. Migration 0081 changes the column DEFAULT only; existing
  rows are deliberately untouched, because mail port exposure is live
  operator-visible configuration and a migration must not silently re-point it.

### Security
- **Runtime-resolved Job images now pin by digest — `rocksdb-secondary-checkpoint`
  first.** The mail-archive checkpoint binary resolved as
  `…/rocksdb-secondary-checkpoint:latest` with no override anywhere, on a mutable
  tag, for an initContainer that opens the live mail store on every archive
  (`no_downtime` is `DEFAULT_ARCHIVE_MODE`). `:latest` is not hypothetical risk
  here: the `is_default_branch` bug froze it at its pre-cutover build on
  2026-06-22 and every consumer silently pulled a stale image.
  The image's own CI now writes an immutable `:<tag>@sha256:<digest>` into the
  development overlay's platform-config after the push, via a new
  `pin-config-image.sh`. It sits alongside `pin-image-tag.sh` rather than
  replacing it: that script drives the kustomization `images:` transformer, which
  by design only rewrites `image:` fields in pod specs and so cannot reach an
  image the backend builds at runtime from an env var. Timing is deliberately the
  same — pin from the image's own workflow, after the push — because pinning from
  a different workflow is what caused the 2026-06-06 pull race.
  Both halves of the reference are intentional: the digest is authoritative and a
  re-pushed tag cannot change it, while the tag keeps the overlay diff readable.
  Verified on a real cluster (k3s v1.31.4) rather than assumed — a Pod with
  `busybox:1.36@<digest-of-1.37>` started and reported `BusyBox v1.37.0`, with
  `imageID` equal to the 1.37 digest. The script REFUSES a tag-only reference, so
  the property cannot be given up by accident.
  The initContainer also drops from `imagePullPolicy: Always` to `IfNotPresent`:
  against an immutable reference a re-pull can only fetch identical bytes, so
  `Always` bought nothing and cost a hard dependency on GHCR being reachable at
  archive time. A new pin changes the digest, which is itself a cache miss.
- **Swept every remaining runtime-launched image onto the same digest pin**, and
  fixed two bugs found doing it. `tenant-backup-tools` — the most-used image in the
  platform, running in backup-restore, storage-lifecycle, tenant-bundles and
  mail-admin — was a bare `TOOLS_IMAGE_DEFAULT` const in six modules that read **no
  env var at all**, so an operator could not repoint it anywhere. And
  `node-terminal`'s own comment said "overridable via NODE_TERMINAL_IMAGE env"
  while nothing in the codebase read that variable. Both look correct at the call
  site; neither was, and neither would fail a build, a test, or a deploy.
  All runtime images now resolve through one table
  (`backend/src/shared/platform-images.ts`) so the env contract is stated once and
  asserted once, and `tenant-backup-tools`, `migration-tools`, `claim-validator`
  and `node-terminal` gained platform-config keys plus `configMapKeyRef` wiring.
  Five more build workflows (`file-manager`, `tenant-backup-tools`,
  `migration-tools`, `claim-validator`, `node-terminal`) now pin their own digest
  after the push. The tag label is the 7-char git sha — exactly what
  `type=sha,prefix=` publishes — rather than a re-derived timestamp, because
  `{{date}}` is evaluated inside metadata-action and recomputing it names a tag
  that was never pushed.
  Two images stay deliberately unpinned, now with the reason recorded rather than
  assumed: `private-worker-agent` is interpolated into the `docker run`/compose
  snippet **tenants run on their own hardware**, so a digest pins what we hand out
  and strands them on a registry GC; and `private-worker-frps` is third-party we
  do not build, so a digest means a manual bump per upstream release with no CI to
  produce it.
- **Digest-pinned every external base image** — 29 `FROM` lines across 19
  Dockerfiles, including `gcr.io/distroless/static:latest`. Each keeps its tag as a
  readable label with the manifest-LIST digest appended (`image:tag@sha256:…`), so
  multi-arch builds still resolve per platform. Paired with a new Dependabot
  `docker` ecosystem, which is the half that matters: a digest is immutable, so it
  also stops receiving upstream security rebuilds — pinning without an updater is
  a slow-motion regression, not a fix. Dependabot understands `tag@sha256:` and
  bumps both halves. Verified by real builds of a distroless/Go image and a
  node/nginx panel image.
- **`dperson/samba` pinned by digest.** It publishes no version tags at all (only
  architecture names and `latest`), so a digest is the only pin available.
- **Hash-pinned the docs toolchain.** `documentation/requirements.txt` pinned four
  versions and said nothing about the ~20 transitive dependencies. A version pin
  stops you adopting a *new* malicious release; it does nothing about a
  *republished* one. The build now installs from a generated
  `requirements.lock.txt` with `pip install --require-hashes` — 29 packages, 339
  hashes — so pip refuses any artifact whose sha256 does not match and refuses to
  install anything unlisted. Regeneration instructions are in the file header.
- **Registered the three unwatched third-party images** (`imapsync`,
  `ziti-edge-tunnel`, `zrok`) in `security/components.yaml`. They were deployed with
  no registry entry, so nothing watched them for CVEs; imapsync is now marked for
  what it is — a Job that reads and writes tenant mailbox content with tenant
  credentials.
- **Signed releases now pin their runtime images too.** `cut-release.sh` already
  snapshotted the development overlay's kustomization pins into production, but
  that transformer only reaches images in a pod spec — the six the backend
  launches from a ConfigMap were left as mutable `:latest`, so a cosign-signed
  release did not actually describe what it ran. The cut now stamps every
  digest-pinned runtime image into the production platform-config too (staging
  inherits), and **fails closed** on a key pinned in development but absent from
  production, which would otherwise silently fall back to the base `:latest`. It
  stamps whatever development has pinned rather than a hand-kept list, so it
  cannot drift when a new image is wired; keys deliberately left mutable carry no
  digest and are skipped. Three new tests cover the stamp, the skip, and the abort.
- **Pinned the three third-party images that were still on `:latest`** —
  `gilleslamiral/imapsync`, `openziti/ziti-edge-tunnel`, `openziti/zrok`. Each is
  pinned to the version `latest` resolved to on 2026-08-07, verified by comparing
  manifest digests, so behaviour is unchanged today and merely reproducible from
  now on. The imapsync comment had asserted "the Docker Hub image only publishes
  `latest` — there is no version-tagged release", which was untrue (2.288, 2.295,
  2.306, 2.319, …); on the strength of it every tenant mail migration ran whatever
  `latest` happened to be that day.
- **Un-shared the seven pre-existing kustomize pin concurrency groups.** They all
  used `pin-development-${{ github.ref }}`, carrying the same defect that dropped
  the tenant-backup-tools pin — one pending job per group, the rest cancelled.
  Each now has its own; both `pin-image-tag.sh` and `apply-development-pin.sh`
  already retry against `origin/development`, so serialising was never what made
  concurrent pins safe.
- **Fixed a pin-losing concurrency bug in the sweep itself.** All the new pin jobs
  initially shared one `pin-development-config` group. GitHub keeps at most **one
  pending job per concurrency group and cancels the rest**, so when five image
  workflows fired together the `tenant-backup-tools` pin was silently cancelled
  while the other four landed — `cancel-in-progress: false` prevents cancelling a
  *running* job, not a queued one. Each pin now has a per-image group. Serialising
  was never needed: `pin-config-image.sh` already carries a 4-attempt
  reset/re-apply/retry loop precisely because concurrent pins are expected.
- **A guard so this cannot silently regress.** `ci-config-image-pin-check.sh`
  classifies every runtime-resolved image key in the development overlay:
  `PINNED` keys must carry an `@sha256:` digest, `PENDING` keys are known-mutable
  **with a written reason**, and anything in neither list fails the build — so a
  NEW Job image cannot land on `:latest` unnoticed, which is exactly how this
  backlog accumulated. It caught one I had missed on its first run
  (`private-worker-frps-image`), and now records why each remaining one is still
  mutable: `file-manager-image` (workflow not yet wired),
  `private-worker-agent-image` (runs on tenant hardware, not in-cluster — a
  different decision), and `private-worker-frps-image` (third-party upstream we do
  not build, so a digest means a manual bump per release with no CI to produce it).
- **`rocksdb-secondary-checkpoint` built from an unpinned dependency graph.** The
  image committed only `Cargo.toml`, and its Dockerfile read
  `COPY Cargo.toml Cargo.lock* ./` — the `*` matched **nothing**, silently, so every
  build re-resolved the whole crate graph against the live crates.io index. The
  crates going into a binary that opens the production mail store were whatever
  existed at build time, not what anyone reviewed. This is not a fringe path: the
  binary is initContainer #1 of `no_downtime`, which is `DEFAULT_ARCHIVE_MODE`, so
  it runs on every operator-triggered mail archive. `Cargo.lock` is now committed
  (36 crates), the glob is gone so a missing lockfile is a hard `COPY` failure, and
  `cargo fetch`/`cargo build` both run `--locked` — the Rust equivalent of
  `npm ci` over `npm install`. Verified by real builds in both directions: matching
  lockfile compiles `librocksdb-sys v0.17.3+10.4.2` and produces a working 31.3 MB
  image; a stale lockfile fails the build with exit 101 instead of quietly updating
  itself. `components.yaml` now points `deps:` at the lockfile rather than the
  manifest — osv-scanner and cargo-audit both read the lockfile, so the previous
  entry gave nominal coverage, not real coverage (36 crates now scanned, 0 findings).
- **The rocksdb↔Stalwart version coupling is now enforced, not commented.**
  `rocksdb-secondary-checkpoint` opens Stalwart's **live** RocksDB store as a
  secondary instance, so both processes read the same MANIFEST and SST files and
  must link the same C++ rocksdb; a mismatch fails against the production mail
  database at archive time, with nothing failing at build time. That invariant was
  held by a Cargo.toml comment reading *"pinned to the same rocksdb Stalwart 0.16.5
  uses"* while Stalwart had already moved to **v0.16.16**. It happened to still be
  correct — both resolve `librocksdb-sys 0.17.3+10.4.2` — but nobody had checked and
  nothing would have said so otherwise. The coupling is now declared machine-readably
  (`tracks: {component, verified_against, crate, crate_version}`) and enforced by
  `ci-rocksdb-stalwart-pin-check.sh`: bumping Stalwart without re-verifying the
  rocksdb pin fails CI. The offline half (registry ↔ Cargo.toml ↔ Cargo.lock all
  agree) runs on every push; the `--online` half fetches Stalwart's `Cargo.lock` at
  the pinned tag and confirms the recorded mapping is true upstream, and runs in
  component-watch. A network blip exits 2, never a false green. All four drift paths
  are negative-tested: Stalwart bumped, crate bumped alone, lockfile drifted, and an
  exact pin loosened to a caret range.
- **js-yaml 4.3.0 → 4.3.1** (`GHSA-5p4m-2wfm-xmqj`, CVSS 7.5). Quadratic CPU
  consumption in `!!omap` resolution — `!!omap` is in the *default* schema, so a
  plain `yaml.load(untrusted)` is affected with no special configuration. Found by
  scanning the current lockfile while verifying unrelated work; it was untracked and
  would have failed the next dep-scan. Remediated rather than waived, since 4.3.1 is
  a patch: both affected copies are transitive (`@kubernetes/client-node`,
  `cosmiconfig`) and `npm update --package-lock-only` reached them inside their
  existing ranges, so no override was needed. Our direct dependency is 5.2.2, which
  the advisory does not cover. The lockfile diff is 6 lines, nothing else moved.
- **Remediated the brace-expansion and fast-uri advisories instead of leaving
  them waived.** `GHSA-rgw5-rvv9-x895` (CVSS 7.5) and `GHSA-7p8r-x3mc-p8w7`
  (CVSS 7.5) were triaged `reachable: false` and left `status: open` with the
  remediation recorded. That remediation is now applied: the root
  `brace-expansion` override moves `^5.0.8 → ^5.0.9` exactly as the ledger
  prescribed, and `fast-uri` takes its patch on both major lines (3.1.4 → 3.1.5,
  4.1.1 → 4.1.2) rather than an override, because ajv needs the 3.x line and
  forcing one major on both would break it. Both ledger entries are now
  `status: fixed`. Verified: OSV no longer reports either package, the
  component-watch gate passes, and the backend suite is 5986 green.

### Fixed
- **`externalTrafficPolicy` on the Traefik helm install broke every fresh
  install.** The apiserver accepts that field only on an externally-accessible
  Service — LoadBalancer, NodePort, or ClusterIP with a non-empty `externalIPs`.
  At helm time the Traefik Service has none (the ingress-external-ips reconciler
  adds them later), so bootstrap died outright at "Installing Traefik v3
  Ingress Controller". It had been added on the strength of a live-cluster patch
  where both fields went in together, and no fresh install was provisioned
  between. The reconciler owns both fields and patches them atomically;
  `ci-service-etp-check.sh` now guards both directions, because dropping the
  policy from the reconciler silently restores kube-proxy's SNAT while every
  request still returns 200.
- **SFTP was dead from first boot on a fresh cluster.** `CNI-HOSTPORT-DNAT`
  carried jumps for the mail ports and 80/443 but none for 23022, so the node
  accepted the SYN and RST'd it: the gateway pod Running, Ready and listening,
  the firewall open, and every external connection refused. Only Traefik had a
  self-heal for this CNI portmap race — and that function's own comments already
  named `:23022` as sharing the chain. Generalised to `ensure_hostport_dnat`,
  covering the SFTP gateway and Stalwart, and probing with a TCP connect rather
  than a rule grep: portmap rules surface as native nft, as a dport *set* when
  one pod publishes several ports, or via xt-compat, so no single grep matches
  them all — and loosening it to the chain name would report "present" for a
  genuinely dead port, since all three workloads share that chain.
- **A completed PITR restore blocked every write, cluster-wide, indefinitely.**
  The orchestration runs in a Kubernetes Job — a separate process — which clears
  the DB lock on success, but platform-api's in-memory `activeRestore` is set by
  the route handler and nothing in that process clears it. The cluster-wide
  check consulted the in-memory flag first and let it win unconditionally,
  despite its own contract naming the DB lock as the source of truth across
  replicas. Since the write-lock middleware runs that check on every non-GET
  request, one finished restore returned 503 `RESTORE_IN_PROGRESS` for unrelated
  admin operations until platform-api was restarted — there is no operator-facing
  release endpoint, and the PITR watchdog does not cover this case (it requires
  FailedCreate events and no Succeeded pods, i.e. only "the pod never ran"). An
  in-memory lock that outlives an absent DB row is now treated as stale, with the
  acquire window preserved and, critically, failing closed when the DB cannot be
  read — during the cutover the source cluster is deleted, which is exactly when
  the in-memory flag is the only guard left.
- **Any Postgres restart killed platform-api.** pg-boss and `pg.Pool` both emit
  `'error'` with no listener, so an ordinary CNPG failover, minor upgrade, PITR
  promote or node drain terminated the process — defeating the deliberately
  shallow `/healthz` that exists so a running pod survives a brief DB blip.
- **A crashed process left `tasks` rows `running` forever**, and drain counts
  those rows, so a single crash blocked every backup-class reassignment and DR
  drill for up to 30 hours with a manual DB edit as the only escape.
- **An "advisory, non-fatal" poll could skip Stalwart configuration entirely.**
  The mail-TLS cert poll sat between steps 5c and 6 of the configure pod, so the
  outer wait deleted the pod mid-poll — before AllowedIp exemptions,
  NetworkListener creation and the admin credential update, and before the
  `configure-ok` marker bootstrap reads to decide whether to roll Stalwart. It
  now runs last, the marker is matched anywhere in the log, and a wait timeout
  with the marker present is no longer reported as a failure.
- **`bootstrap.sh --remote` could never configure a backup target.** The
  `--backup-target-s3-*` flags deliberately refuse the access/secret keys as
  arguments so they cannot leak into `ps`, reading them from the environment
  instead — which ssh does not forward, and `--remote` forwards CLI args only.
  Every remote install that passed the documented flag combination warned and
  skipped. The credentials now cross on the SSH channel's stdin, never in the
  command string (which becomes the remote shell's argv) and never on disk.
- **`--env dev` selected a ClusterIssuer that does not exist**, leaving every
  platform Certificate unissuable on a real DEV cluster.
- **Service `externalIPs` without `externalTrafficPolicy=Local` hid every client
  IP** behind kube-proxy's SNAT, blinding CrowdSec, the WAF, the panels' real_ip
  chain and tenant access logs.
- **Idempotence markers outlived the artifacts they guard**, so a re-bootstrap
  silently skipped work whose output had been wiped.
- **Mail health now checks reverse DNS for IPv6 too**, and grades a missing
  record by family — a missing IPv4 PTR breaks the primary send path, while a
  missing IPv6 PTR does not stop mail leaving over IPv4 — instead of framing
  either as a gate on sending.
- **`destroy-cluster.sh` reported "all nodes wiped" and exited 0** immediately
  after printing a node's non-zero exit code: the per-node subshell ended with an
  `echo`, so its status was always 0 and the failure count never incremented.
  Also fixed: every node without NetBird failed the wipe (a missing `wt0` was
  treated as a failure without asking whether it had ever existed), and roughly
  1 MB of `Operation not permitted` from Calico's cgroup2 bind-mount buried the
  result — the mount is now released first, taking a node's wipe log from
  1,068,519 bytes to 451.
- **Self-upgrade could never resolve a DEV cluster's binary.** The
  `platform-version` ConfigMap is stamped `<VERSION>-<short-sha>` by build-deploy,
  and self-upgrade used that verbatim as the release tag — asking GitHub for
  `v2026.8.2-d847808`, which does not exist. The node then kept whatever binary it
  had, which is how DEV ran a July build against an August cluster. Assets are now
  fetched from `releaseTagFor(version)`, which strips a lone git-sha identifier and
  deliberately leaves a real prerelease (`-rc.N`) alone. Version *comparison* still
  uses the full string, so a node on `2026.8.2` does not flap when the ConfigMap
  says `2026.8.2-<newsha>`.
- **DEV's Flux could not apply anything** — an unescaped `${base}` in the
  `stalwart-extra-ca` init container failed Flux 2.9's strict envsubst
  (`variable not set (strict mode): "base"`), so *every* Kustomization apply
  failed and the cluster froze on an old revision. Escaped to `$${base}`.
- **`ci-flux-escape-check.sh` was blind to it**: the guard quick-rejected any
  manifest that was not `kind: CronJob|Job`, so a Deployment init container — or
  a kustomize component patch with no kind at all — was never scanned. It now
  scans anything with an `args:`/`command:` block. Two matching refinements keep
  it precise: names Flux genuinely substitutes (`DOMAIN`, `ENV`,
  `CLUSTER_ISSUER_NAME`, `STALWART_EXTERNAL_IP`) are allowed bare, and YAML
  comments — stripped by kustomize before substitution — are no longer flagged,
  which previously would have fired on the very comments documenting the rule.

### Fixed
- **`platform/VERSION` on `development` now tracks the release line.**
  `cut-release.sh` writes it on `main`, and promotion is one-way
  `development → main`, so the stamp never came back: `development` sat on
  `2026.6.16` — a version never cut — for six weeks. That is what a fresh install
  resolves its platform-ops asset from, so the download 404'd, the install was
  skipped, and the node got no converge timer at all. A new
  `sync-development-version` release job pushes the released version back to
  `development` (stable releases only: build-deploy stamps `<VERSION>-<sha>`, and
  an RC would compose to `2026.8.3-rc.4-<sha>`, which the backend's version regex
  rejects — silently breaking `installed_platform_version`). Also makes the
  promote snapshot idempotent, which used to revert `main`'s stamp until
  cut-release rewrote it.
- **Chart-bump host-migrations no longer try to DOWNGRADE a newer cluster.** The
  guard compared the installed chart version to the target with string equality,
  so a node bootstrapped *after* the migration was written — carrying newer pins —
  did not match, and the migration ran `helm upgrade --reuse-values` onto an
  OLDER chart. That fed the old chart values whose schema it does not know, and
  it failed: cert-manager rejected `runtimeClassName`, which blocked 15 later
  migrations behind it (ADR-056). A chart bump now establishes a **floor, never a
  ceiling** — it skips when the release is at or above the target. Affects the
  five chart-bump migrations under `2026.7.1/`.
- **A dormant self-upgrade no longer silently disables host-migration
  convergence.** Every dormancy path in the platform-ops install (no trust anchor,
  no published asset, missing signature, failed verification) returned before
  installing the systemd units — so a node pinned to a platform version that was
  never cut as a release got *no converge timer at all*, and its host migrations
  could never run. Refusing to REPLACE the binary is a trust decision; refusing to
  converge an already-installed one is not. The host-config timer is now installed
  whenever a usable binary is present, and still skipped when there is none.

### Security
- **Image builds now install the lockfile instead of re-resolving it.** Every
  Dockerfile ran `npm install` against a workspace's `package.json` with no
  lockfile in the build context, so each build re-resolved the `^` ranges
  against the live registry — meaning `package-lock.json`, the file that is
  audited, scanned and cross-referenced against IOC lists, did **not** govern
  what shipped. A version published between two builds landed in the image even
  when the lockfile pinned a safe one, which is precisely how a
  hijack-and-republish compromise propagates. All three images now copy the root
  lockfile plus every workspace manifest and use `npm ci --workspace <pkg>`,
  which installs the locked tree or fails. Verified by building each image and
  comparing installed versions against the lockfile.
  Two things fell out of the change: the flattened layout's `sed` rewrites of
  `package.json`/`tsconfig.json` are gone (the workspace layout resolves
  `@insula/*` natively), as is the `rm -rf node_modules/react*` workaround —
  npm hoists a single React, now asserted at build time rather than patched
  after the fact. The panel **builder** stages move to `node:22-slim`, because
  the lockfile is generated on glibc and records no musl binding for rolldown;
  the previous `npm install` masked that by silently re-resolving on Alpine.
  Runtime images are unchanged.

### Security
- **Dependency supply-chain hardening.** Four controls, aimed at the class of
  attack where a package is *hijacked and republished* rather than found
  vulnerable — the 2026-08 keyv/@adminide-stack wave, which no CVE feed would
  have flagged. (1) `.npmrc` sets `ignore-scripts=true`: a dependency's
  install script runs with the full privileges of whoever ran `npm ci`, which
  in CI means the registry credentials and push token, and it executes without
  the package ever being imported. The Dockerfiles already passed
  `--ignore-scripts`, so this closes the same hole for CI runners and developer
  machines. (2) Dependabot gains a 7-day cooldown (14 for majors) so a bot bump
  can no longer adopt a malicious release within hours of publication; security
  updates are advisory-driven and remain immediate. (3) A new dependency-audit
  workflow runs `npm audit signatures` — registry signatures and provenance,
  which detect a *tampered* artifact that no CVE feed will ever mention — daily,
  because a dependency can be compromised long after it entered the lockfile.
  (4) All 228 GitHub Actions references are now pinned by commit SHA rather than
  mutable tag — **and `ci-actions-pinned-check.sh` now enforces it**. The manual
  pass had already drifted to 227/228 within a day: `actions/checkout@v7` in
  release.yml's version-sync job, which runs with `permissions: contents: write`,
  so a retagged release would have executed in a runner holding a repo write
  token (the tj-actions/changed-files pattern). Pinning by hand is a one-time
  act; the guard is what makes it a property.
- **A `not_affected` entry for `GO-2026-5932`** (`golang.org/x/crypto`). The
  advisory is module-scoped — "the openpgp subpackage is unmaintained and unsafe
  by design" — so OSV flags every consumer of x/crypto regardless of which
  subpackage they import, and it carries no CVSS and no fixed version. Untriaged
  it printed an unactionable ⚠ on every scan, forever. Verified unreachable by
  resolving the real build graph (go1.26.5, `go list -deps ./...`, rc=0) rather
  than grepping our own source, since a transitive dependency could have pulled
  openpgp in: sftp-gateway resolves 594 packages, file-manager 171, and openpgp
  is in neither. The x/crypto packages actually compiled are ssh, chacha20poly1305,
  curve25519, cryptobyte, blowfish and bcrypt_pbkdf.
- **The dependency gate passed malicious packages.** `component-watch-gate.py`
  classified findings purely by CVSS, and a `MAL-` advisory — the OSV record for
  a package that has been hijacked and republished — usually carries no severity
  at all. Such a finding therefore landed in the *unknown severity* bucket, which
  prints a ⚠ and exits **0**: a hostile package in `package-lock.json` produced a
  green check and a mergeable PR. The gate now blocks any `MAL-` finding
  regardless of score, matched on ids *and* aliases (the MAL- id often rides along
  as an alias of a GHSA primary). Waiver rules are deliberately narrower than for
  CVEs: only `not_affected` (confirmed false positive) or `fixed` (removed and
  lockfile regenerated) clear one — `open`/`investigating`/`mitigated`/`accepted`
  all mean "we'll get to it", which is not an answer for a package that is
  currently stealing tokens. All sixteen rules are pinned by
  `.github/scripts/test-component-watch-gate.sh`, verified to fail 6/16 against
  the previous gate and to leave CVE handling byte-identical.
- **Consolidated the two OSV scanners into one.** The dependency-audit workflow
  added yesterday carried its own lockfile OSV scan with an inline malicious-
  package gate, duplicating `component-watch.yml`'s recursive scan and splitting
  the rules — and the waiver point — across two files. The malicious-package
  gating moved into `component-watch-gate.py`, next to the ledger it consults,
  and the duplicate job was deleted; `component-watch.yml` is now the only OSV
  scanner in CI and additionally covers `go.mod`/`Cargo.toml`, which the removed
  job never did. Its dep-scan also drops from weekly to **daily**, so the window
  between a MAL- advisory being published and this repo noticing is ~24 h rather
  than up to 7 days. `npm audit signatures` stays in dependency-audit: it answers
  "is this the artifact the maintainer published?", which no advisory feed can.

### Added
- **The node's IPv6 is now visible in the admin panel** (migration 0080,
  `cluster_nodes.public_ipv6`). Node sync stored a single `public_ip` taken from
  the first `ExternalIP`, which on a dual-stack cluster is always the IPv4 — so
  an operator had no way to read the node's global IPv6 short of SSH-ing to it,
  even though `ingress_default_ipv6` (which drives every apex AAAA record) is
  operator-set and needs exactly that value. Address selection is now per
  family. The v4 keeps its ExternalIP→InternalIP fallback (on a single-NIC VPS
  the InternalIP *is* the public address); the v6 deliberately does not, because
  the v6 InternalIP may be a ULA and reporting a ULA as a node's public address
  points the operator at an off-link address. This also fills the `v6Set` in
  `getPlatformIngressIps()`, whose `includes(':')` branch could never match
  before — the node-sourced half of AAAA domain verification was dead code.
- **Email → Data Drift warns when a dual-stack cluster publishes no AAAA for
  its mail hostname.** A cluster bootstrapped `--dual-stack` accepts SMTP/IMAP
  over IPv6 on every mail node, but a v6-only client can only find it if
  `mail.<apex>` publishes AAAA. When it doesn't, nothing breaks and nothing
  complains — IPv4 carries every connection, so the operator who deliberately
  asked for IPv6 gets none of it and has no signal. It belongs on the drift page
  because it is the same failure shape as the rest of it: the platform's real
  state and its published state disagree. Backed by a new `ipv6Dns`
  deliverability sub-probe (also shown in the mail-health details modal) that
  additionally flags partial coverage and stale AAAA pointing at non-mail nodes.
  Deliberately `warning`, never `fail` — mail is fully functional, and
  red-lighting the dashboard over a reachability nicety trains operators to
  ignore it. Inert on single-stack clusters.
- **Smoke test 10: published AAAA vs the cluster's actual IP stack.** Publishing
  AAAA on a single-stack cluster gives every v6-preferring client a connection
  reset and a silent fallback to IPv4 — invisible in every other check, and how
  the testing box ran for months. Test 10 fails that, and on a dual-stack
  cluster additionally requires each published AAAA to actually *serve*, so a
  stale record pointing at a decommissioned node is caught too.
  `scripts/test-smoke-aaaa-guard.sh` drives all four branches offline, because a
  false FAIL here would turn `make smoke` red on every existing single-stack
  production cluster.
- **Host-migration state is visible in the admin panel** (Platform → Updates).
  A failed migration blocks every later one on that node, and the only way to
  discover it was to SSH in and run `insula host-config` — the DEV cluster sat at
  `0 applied, 11 pending` behind a single failure for five weeks. The card shows
  per-node applied/pending/failed/blocked/skipped counts, the failure's cause,
  how many times it has repeated and since when (ADR-056), any operator skip and
  its reason, and links the troubleshooting runbook. A broken node expands
  itself; a healthy or not-yet-reported node deliberately does not raise an
  alert.
  - Costs **no new privilege**: the converge writes a node-local `status.json`
    and the existing `host-config-reconciler` DaemonSet — already on every node,
    already publishing a per-node ConfigMap — relays it through a **read-only**
    mount. Publishing from `platform-ops` was rejected because RBAC cannot scope
    `create` by resource name, so a worker would have gained the ability to
    create any ConfigMap in `platform-system`.
  - No retry button, by design: the backend cannot touch a node, and the converge
    already runs hourly and picks up a fixed condition on its own.
  - Three failure shapes that would otherwise still have read as healthy are
    surfaced explicitly: a **whole-run refusal** (catalog over the script cap,
    which arrives with `ok:false` and *no items*, so every count is legitimately
    zero), an **invalid** script that can never run, and a node that **breaks
    between polls** (the per-node auto-expand now tracks state instead of only
    the first render). Applied state is reported cumulatively — the relay counts
    only what ran in that pass, so a fully caught-up node used to render "0
    applied", indistinguishable from one that had never run anything.
  - The relay caps field and list sizes. A failed migration's stderr is relayed
    verbatim and the whole snapshot lives in one ConfigMap, so an unbounded blob
    would breach etcd's ~1 MiB limit and freeze that node's reporting at its
    last-known state — precisely when the panel matters most. Counts are derived
    before capping and the API takes `max(relayed, recounted)`, so truncation can
    never hide a failure.

### Added
- **A failure policy for host-migrations (ADR-056).** Halting on the first
  failure is right — a later migration may assume an earlier one applied — but as
  shipped it was unscoped, unrecoverable and silent: one deterministic failure
  parked every later migration indefinitely, the only escape was `touch`ing a
  `.done` marker (which makes the node report `applied` for a script that never
  ran), and nothing escalated. The DEV cluster proved it, sitting at `0 applied,
  11 pending` behind a single failure for five weeks.
  - A migration may declare `# blocks-on-failure: no` when nothing later depends
    on it, so an independent script no longer wedges the chain. **Absent means
    `yes`**, so existing migrations keep today's safe behaviour; CI rejects any
    value other than `yes`/`no`.
  - An operator can record a `.skipped` marker carrying a reason. It is reported
    as `skipped` — never `applied` — so the node's state stays honest, and it does
    not block.
  - Repeat failures carry an attempt count and a first-seen date, and a blocked
    chain now names what it is blocked behind and links the runbook.
  - The authoring contract distinguishes "not applicable to this host → exit 0,
    loudly" from "tried and failed → exit 1"; `new-host-migration.sh` says so in
    the stub.

### Fixed
- **`integration-mail-external-reachability` was banning its own prober.** The
  suite opens 6 ports × every node × 4 phases from one source address, which is
  enough for Stalwart to auto-ban it. A banned source is dropped *silently* —
  the TCP handshake completes and the server then EOFs without greeting — so the
  suite read a perfectly healthy mail server as dead. It now declares itself to
  Stalwart before probing (clears any stale `BlockedIp` entry for its own source
  and allowlists it for the run, removing the entry on exit), scoped to that one
  address so every other rate-limit decision stays enforced. An empty banner on
  a port that *accepted* the connection is now reported as exactly that, rather
  than as a dead listener.
- **Stalwart's rate-limit exemption covered IPv4 only.** The `x:AllowedIp`
  entries bootstrap seeds for the cluster pod and service ranges were hardcoded
  v4 literals, so on a dual-stack cluster the IPv6 ranges stayed subject to
  Stalwart's connection and login limits. They now follow the real dual-stack
  CIDRs, one entry per family, and an existing cluster gains only the missing v6
  entries when re-run.
- **Dual-stack clusters denied tenants all IPv6 egress.** The
  `platform-cluster-cidrs` ConfigMap that tells the backend the cluster's pod and
  service ranges was never created — on *any* cluster: the guard around it read a
  variable that was `local` to a sibling shell function, so it was always empty.
  On an IPv4-only cluster this was invisible, because the backend's built-in
  defaults happen to be the same `10.42.0.0/16` / `10.43.0.0/16`. On a dual-stack
  cluster it meant `buildTenantNetworkPolicies` never learned the IPv6 ranges, so
  it emitted no `::/0` egress rule at all — and because that policy sets
  `policyTypes: [Egress]`, having no v6 rule denies IPv6 outright. A tenant pod
  could reach the node over IPv4 but not over IPv6, so a tenant app whose
  resolver preferred the AAAA of `mail.<apex>` could not send mail. Both
  consumers now share one `cluster_cidr_args()` helper, and
  `resolveTenantNetworkCidrs` falls back to the nodes' own `spec.podCIDRs` when
  the ConfigMap names no v6 range, so existing dual-stack clusters self-heal
  without a rebuild. Cross-tenant isolation was verified to hold over both
  families before and after the fix.
- **`--node-external-ip` published IPv4 only on a pinned (mesh/VLAN) underlay.**
  `--dual-stack` appended the node's IPv6 in the public-underlay branch but not
  the pinned one, so the Node object carried a v4-only `ExternalIP` and the
  `ingress-external-ips` reconciler published a v4-only list on the Traefik
  Service. Both branches now take that address from a `global-only` detector:
  a ULA is a perfectly good `--node-ip`, but announcing one as externally
  reachable points clients at an off-link address, so a ULA-only host correctly
  announces no IPv6 at all.
- **The pod-CIDR control-plane firewall exemption was IPv4-only on dual-stack.**
  The nft table is family `inet`, where `ip saddr` matches IPv4 exclusively;
  `--dual-stack` now emits the matching `ip6 saddr` rule. The single-stack
  ruleset is unchanged byte-for-byte.

## [2026.8.3-rc.4] - 2026-08-05

### Fixed
- **Host-migrations could never apply during a platform upgrade.** The
  post-upgrade converge ran as a child of `platform-ops-update.service`, which is
  hardened with `ProtectSystem=strict` and `ReadWritePaths` limited to the binary
  directory and `/etc/platform` — correct for a signature-verifying self-upgrade,
  and inherited by everything it spawns. A host-migration's entire job is writing
  host files, so any migration that touched the filesystem died on a read-only
  mount, the converge exited 1, and the release's migrations waited for the next
  timer tick. Caught on staging with the diagnostics added earlier in this
  release: the same migration failed with `mktemp: … Read-only file system` under
  that unit and applied cleanly under `platform-ops-host-config.service` seconds
  later. The converge is now dispatched to that unit — which owns a sandbox built
  for the work — instead of inheriting the wrong one; relaxing the self-upgrade's
  hardening to suit its child would have weakened the path that verifies release
  signatures. Falls back to in-process only where there is no systemd to
  delegate to.

### Changed
- **The host-config converge now runs hourly instead of daily.** That converge is
  what applies a release's host-migrations, and a script that fails — or is
  blocked behind a failure — is retried only on the next tick. At daily plus up
  to an hour of jitter that was ~25 hours of a cluster sitting on an unapplied
  migration with nothing surfaced anywhere, which is how the 2026-08-05 staging
  failure went unnoticed. The run is idempotent and costs about a second when
  nothing is pending. Fresh installs get it from `bootstrap.sh`; existing
  clusters from host-migration `2026.8.3/0002`, which rewrites only the shape
  bootstrap wrote and leaves an operator-customised schedule alone.

### Added
- **A troubleshooting runbook for failed host-migrations**
  (`docs/operations/HOST_MIGRATION_TROUBLESHOOTING.md`): how to read the
  `applied` / `pending` / `run-failed` / `blocked` states, why one failure blocks
  the rest, how to re-run the converge by hand, and the chart-values-schema cause
  seen in the wild.

### Fixed
- **`admin-password-reset.sh` left a Secret holding the previous password.**
  Changing the password through the UI deletes `platform-admin-seed` on purpose
  — `auth/seed-cleanup.ts` exists because a Secret whose password no longer
  works is a silent trap: it still ships in the secrets bundle and still looks
  like a valid credential during incident response. The CLI break-glass path
  skipped that cleanup, so a reset left the stale value behind; a staging login
  against the seed failed on 2026-08-05, which is how it surfaced. The script
  now removes the Secret too (best-effort — the password change has already
  committed, so a kubectl hiccup must not fail the reset). Verified live on
  staging: Secret present before, absent after.

### Changed
- **The panels' settings page no longer ships password inputs in the entry
  chunk.** Routes are not code-split, so the inline change-password form on
  `UserSettings` was compiled into the bundle every page view downloads, which
  is what makes password managers prompt on unrelated pages. It now reuses the
  same lazily-loaded `ChangePasswordModal` as the header, so the inputs are
  fetched only when the operator asks to change their password — and the
  duplicated form is gone. Measured on the admin panel: the entry chunk went
  from 21 password inputs to 18. **This does not finish the job**: the remaining
  18 come from twelve other pages (admin users, backup targets, OIDC, registry
  credentials, …) that are all eagerly imported. Route-level code splitting is
  the actual fix.

### Changed
- **Stalwart mail server v0.16.14 → v0.16.16.** Two upstream patch releases, all
  fixes plus two additive changes; no breaking changes and no new security
  advisories since the previous pin. The three changelog entries that could have
  affected us do not: the Redis task/queue lock-leak fix is moot because our
  Coordinator is disabled, we never set `maxMessageSize`, and we use no registry
  `#id` references. Verified by an in-place upgrade on a real RocksDB store
  (40 messages, 40 spam training samples, 2 accounts, 1 domain): v0.16.16 opens
  the v0.16.14 store, all 26 registry objects the platform calls stay reachable,
  IMAP still serves the pre-upgrade mailbox, every `configure_stalwart_full`
  settings payload still applies — and **rollback to v0.16.14 works with data
  intact**, so the bump is revertible rather than one-way. Delivered by Flux as
  an app manifest, so existing clusters pick it up on reconcile; no
  host-migration is involved.

### Fixed
- **The mail archive/DR export ran a Stalwart binary eleven releases behind the
  server.** `archive.ts` defaulted the export/import Job to a hardcoded
  `v0.16.5` while the Deployment ran v0.16.14 — nothing forced the two to move
  together, and `security/components.yaml` only watches the Deployment, so the
  archive image got no release tracking and no vulnerability scanning. That
  binary reads the server's own RocksDB store, so it is the one image that must
  track the server. The Job now resolves its image from the live `stalwart-mail`
  Deployment (explicit `STALWART_IMAGE` still wins; a pinned fallback covers an
  unreadable Deployment and is asserted equal to the manifest by a test that
  fails if either side drifts). Testing showed the old pin still exported a
  v0.16.16-written store byte-identically, so this closes a drift and scanning
  gap rather than a live data risk.
- **Harnesses could call the shared env lib before sourcing it.** The apex sweep
  left seven suites using `resolve_platform_apex()` in a `${VAR:-…}` default
  above their `source` line — latent, because the default only evaluates when
  the variable is unset, so it passed with a profile and would have exploded
  without one. `integration-bundle-coverage` also got a bare
  `require_backup_class_or_skip` call in that position and died with
  `rc=127: command not found`. The `source` now precedes first use everywhere,
  and `ci-no-hardcoded-test-apex.sh` grew a third check that fails the build on
  a use-before-source.

### Fixed
- **Image reaps that succeeded were being recorded as failures.** The removal
  check ran once, immediately after `crictl rmi` — but containerd settles the
  removal asynchronously, so the reference can still resolve for a moment and
  the reaper logged `failed on <node>` for images the node really had removed.
  (Introduced with the verification that replaced the previous *false success*;
  failing closed was the safer direction, but `image_reap_log` then
  under-reported.) The check now polls before concluding.

### Added
- **IPv6: `bootstrap.sh --dual-stack` (R13).** Until now an IPv6-only client
  could reach nothing the platform serves — not the panels, the API, tenant
  routes or mail. The firewall and DNS layers were already dual-stack, so v6
  traffic was permitted and then went unanswered: on a node with a published
  AAAA, connections got a TCP RST in 8 ms while IPv4 served normally. The cause
  was one layer — the cluster network was IPv4-only, and every public surface
  reaches the outside through `hostPort` → CNI portmap DNAT to an IPv4 pod IP.
  `--dual-stack` gives k3s dual `--cluster-cidr`/`--service-cidr` and
  `--node-ip=<v4>,<v6>` (on servers **and** workers — a v4-only node cannot join
  a dual-stack cluster), adds a Calico IPv6 IPPool with
  `nodeAddressAutodetectionV6`, and enables IPv6 forwarding with `accept_ra=2`
  so the node keeps its own default route. Pods get ULA addresses behind
  `natOutgoing`, exactly mirroring the IPv4 model, so the node's global IPv6 is
  what clients talk to. Downstream: the Traefik Service becomes
  `PreferDualStack`, `ingress-external-ips` collects both families,
  HAProxy mail binds `:::<port> v4v6` instead of the IPv4-only `*:<port>`, and
  `webmail.<domain>` gains an AAAA when an IPv6 is configured.
- **The flag is opt-in and refuses rather than guesses.** k3s cannot change
  cluster CIDRs after install, so defaulting it on would make re-bootstrapping
  an existing host destructive; a single-stack install is byte-for-byte what it
  was. Bootstrap fails at preflight — before the first mutation — when
  `--dual-stack` is requested on a node with no usable IPv6, and refuses to fall
  back to a public IPv6 on a pinned/mesh underlay rather than splitting pod
  traffic across two networks. A node that *has* IPv6 and is being installed
  single-stack now gets a preflight warning, at the one moment the choice is
  still free. `VMTEST_DUAL_STACK=1` gives the VM tier a ULA v6 subnet and then
  asserts on the live cluster that the ingress genuinely answers over IPv6.

### Security
- **The WAF audit log no longer records bearer tokens and session cookies.**
  `SecAuditLogParts` includes request headers, so every blocked request wrote
  the caller's full `Authorization: Bearer <jwt>` and `platform_session` /
  `platform_refresh` cookies in cleartext to the modsec-crs pod's stdout — and
  a WAF block is exactly when an admin's live credentials are most likely to be
  captured. Neither obvious fix was available: libmodsecurity 3.0.16 rejects
  `sanitiseRequestHeader` at config-parse time and crash-loops the WAF, and
  dropping the header part breaks WAF Events, which resolves the client-facing
  hostname from `X-Forwarded-Host`. The JSON audit record now goes to a file
  and an `audit-redactor` sidecar streams it to stdout with those headers
  masked; nginx's own `ModSecurity:` error lines are unaffected. WAF Events
  keeps everything it reads — hostname, URI, method and contributing rule ids —
  and the scraper now names both containers explicitly.

### Fixed
- **A deleted tenant's mail kept occupying the mail PVC for up to 180 days.**
  Stalwart blob storage is reference-counted, and a spam-classifier training
  sample pins the message blob through a `BlobLink::Temporary { until }` stamped
  at ingest as `midnight + SpamClassifier.holdSamplesFor` — 180 days on an
  upstream-default install. Destroying the account does not release it
  (Stalwart's `destroy_account_blobs` unlinks only Email/FileNode/SieveScript
  hard links), so the bytes stayed on disk invisibly: the mailbox was gone and
  the account quota read 0 B. Measured on v0.16.16 — 2 GiB of expunged mail
  survived EXPUNGE, every forced purge task, and outright account deletion, then
  fell to 11 MB in a single compaction once the samples were destroyed. Tenant
  and domain teardown now purges each mailbox principal's training samples
  before destroying the principal (paged, deadline-bounded, best-effort — a mail
  outage still cannot wedge a deletion), and `bootstrap.sh` sets
  `holdSamplesFor` to 30 d to bound every path the hook does not cover.
  Existing clusters are converged by host-migration
  `2026.8.3/0001-stalwart-spam-sample-retention` (bootstrap.sh reaches fresh
  installs only) — it reads the current value first and moves *only* the
  upstream 180 d default, so an install an operator tuned on purpose keeps its
  setting. That runbook and ADR-046 previously blamed disabled RocksDB blob GC —
  which upstream shipped in v0.16.10 and which was never the binding constraint;
  both are corrected.
- **A transient Traefik plugin download could leave a fresh install with no
  admin panel, permanently.** Traefik fetches its plugins from
  plugins.traefik.io at startup and disables the *entire* plugin subsystem if
  any single one fails. It then keeps serving while every router that uses a
  plugin middleware is dropped as "invalid middleware type" — including
  `platform-ingress`, which carries both panels. The cluster came up with
  healthy pods and valid certs, 404 on `admin.<apex>` and `tenant.<apex>`, and
  nothing self-healing, because plugins are only installed at process start.
  Bootstrap now checks for the failure after installing Traefik, recycles the
  pod to retry the download (bounded), and reports the real cause if it still
  fails. `verify_install` no longer attributes the resulting 404 to TLS — it
  names the plugin failure and the one-line fix.

- **Eager image reaps were lost on any platform-api restart, silently.** The
  5-minute grace period lived in an in-process `setTimeout`, so a deploy, Flux
  reconcile, OOM kill or drain inside that window dropped the reap with no
  `image_reap_log` row, no retry and nothing to find afterwards — the image then
  sat on the node until the pressure watcher reclaimed it under disk pressure,
  which is what eager reaping exists to avoid. Reproduced on the DEV cluster,
  which rolls platform-api on every push: a deployment deleted at 13:43:44 armed
  a timer for 13:48:44, the pod was replaced at 13:49:28, and the reap never
  ran. Pending reaps are now persisted (`pending_image_reaps`, migration 0079)
  and swept by a scheduler; claims use `DELETE … RETURNING`, which is atomic, so
  each row runs on exactly one replica — superseding the old
  "at-most-once-per-replica" caveat and its deferred distributed lock. Failed
  reaps retry with capped backoff and give up loudly instead of vanishing.
- **The image purge reported removals it had not performed.** `crictl rmi`
  answering "no such image" was mapped straight to REMOVED, but that message
  means both "already gone" and "this ref does not resolve on this runtime" —
  and in the second case the image was still on disk. The reaper then logged
  `succeeded=true` with a byte count copied from kubelet's node status, a figure
  it never measured. Removal is now confirmed against the runtime
  (`crictl images -q`), so a ref that cannot be resolved reports FAILED.

### Added
- **"How to connect to your email accounts" guide in the tenant panel.** A button
  next to the domain pill on Email opens a tabbed dialog with end-user setup
  instructions for the selected domain. *Email clients* gives the server
  hostname, the full port/encryption table, the username format (always the full
  address) and where app passwords come from — including that the panel login
  will not work in a mail client and that the secret is shown only once.
  *Webmail* covers both routes in: the panel's per-mailbox Webmail button (no
  password needed) and the direct URL a mailbox owner can bookmark, signing in
  with the same app passwords. Backed by a new read-only endpoint
  `GET /api/v1/tenants/:tenantId/email/domains/:domainId/connection-info`
  (tenant-scoped) so nothing in the guide is hardcoded in the UI.
- `MAIL_SERVICE_PORTS` in `@insula/api-contracts` is now the single source of
  truth for mail-client ports. The Mozilla autoconfig and Outlook autodiscover
  XML render from it instead of inline literals, so the settings a client
  fetches automatically and the ones a human reads in the guide cannot drift
  apart; tests assert both surfaces agree.

### Changed
- **Change Password now opens a lazily-loaded modal instead of rendering inside
  the user menu.** The form lived in `Header.tsx`, which is part of the main
  bundle on every page of both panels — so the password fields shipped with the
  entry chunk on every load, and browser password managers latched onto them.
  The form moved to `ChangePasswordModal.tsx` in each panel, pulled in with
  `React.lazy()`, so its chunk is fetched only when an operator or tenant
  actually clicks Change Password. Verified in a real browser against a live
  cluster: zero `input[type=password]` in the DOM on load and with the menu
  open, no chunk request until the click, three fields after it, and none again
  once the dialog closes. The dialog also gains Escape-to-close, a backdrop
  click, labelled inputs and `role="dialog"`.

### Fixed
- **Integration suites failed for three reasons that were never the platform.**
  (1) The custom-container subscription gate shipped on 2026-07-30 without
  updating the suites that exist to exercise custom containers, so every create
  returned `403 CUSTOM_CONTAINERS_NOT_IN_PLAN` (and `T10` reported "expected
  422, got 403" because the gate short-circuits validation); both suites now
  grant themselves the per-tenant override. (2) `API_BASE` defaulted straight to
  the local-dev apex in four harnesses — operator profiles set `ADMIN_HOST` /
  `API_URL`, never `API_BASE` — so against a remote cluster every request went
  to localhost and came back `000`, reading as a broken platform rather than a
  misdirected test; it now derives from the configured target. (3) Backup/DR
  suites hard-failed on a cluster with no backup target bound; nine now report
  SKIPPED via the new `require_backup_class_or_skip`, which checks live cluster
  state and fails open if it cannot determine the answer. The apex guard grew a
  second check so an `API_BASE` regression is caught in CI.
- **Integration harnesses baked in a test apex instead of deriving it.** 113
  literals across 51 scripts, and the same file could be inconsistent with
  itself — three non-deriving `${MAIL_DOMAIN_APEX:-staging.example.test}` lines
  sat next to two correct ones. A suite written that way only passes on the
  apex whose name happens to be baked in: a run against a freshly bootstrapped
  cluster reported `banner 'mail.<cluster apex>' DOES NOT MATCH expected
  'mail.staging.example.test'` while mail was in fact healthy. Every default now
  derives through `resolve_platform_apex()` in `scripts/lib/integration-env.sh`
  — the one place the fallback is written down, honouring `MAIL_DOMAIN_APEX` /
  `PLATFORM_DOMAIN` / `PLATFORM_BASE_DOMAIN` / `HTTPS_TEST_DOMAIN_BASE` /
  `TENANT_BASE`. New CI guard `ci-no-hardcoded-test-apex.sh` fails the build on
  any re-introduction, so this stops being a recurring fix. (Portability, not
  secrecy — `staging.example.test` is the sanitised placeholder; real operator
  domains remain covered by `ci-no-hardcoded-test-infra.sh`.)

## [2026.8.2] - 2026-08-03

### Fixed
- **"Check for updates" never checked.** The button called `refetch()` on the
  version query, which only re-reads the value the hourly poller CronJob last
  wrote to the database — and with a 60-second `staleTime` repeated clicks did
  not even reach the network. So a release published since the last tick stayed
  invisible however many times an operator clicked, until the next hourly run.
  It now runs a real poll through the same cosign-verified path the CronJob
  uses, and seeds the card with the fresh result. A GitHub outage degrades to
  "no change" rather than an error.

### Fixed
- **The WAF blocked any admin field holding a URL written as an IP address.**
  OWASP CRS rule 931100 ("URL Parameter using IP Address") matches any argument
  value of the form `http://<ip>`, which scored 5 and tripped the blocking
  evaluation — so adding a self-hosted DNS server on a mesh IP, a MinIO backup
  target on a LAN IP, a private registry or an ACME server all returned a bare
  nginx `403`. The request never reached platform-api, so nothing appeared in
  the API log or the panel's access log and only the modsec-crs pod knew why.
  Storing operator-supplied endpoints is what these routes are *for*: they are
  Bearer-authenticated, Node never include()s the value, and the rule only ever
  rejects IP *literals* (a hostname passes untouched), so it blocked a normal
  workflow while adding no protection. Rule 931100 is now excluded on the
  platform-API hosts under `/api/v1/`; tenant workloads keep full coverage.
- **WAF Events' "Whitelist this rule for this host" never took effect.** Two
  independent causes. Flux owned the `data` key of the dynamic exclusions
  ConfigMap and reset it to the empty seed on every reconcile, so the
  reconciler's rendered rules were reverted within minutes — visible as
  "ConfigMap updated (drift detected)" every ~5 minutes and a modsec-crs roll
  each time. And the button offered the wrong rule: at paranoia level 1 the rule
  that *matches* acts with `pass` and emits no error line, so only the rule that
  *denies* (949110) was ever recorded — whitelisting it is a no-op, and
  disabling it would switch off blocking for the entire host. The ConfigMap is
  now annotated `ssa: IfNotPresent`, and the scraper records the contributing
  rules from the audit record so the offered rule is the one that can fix it.
- **Connection failures when adding a DNS server said only "fetch failed".**
  Node's fetch collapses every transport failure into that one string, so an
  unresolvable hostname, a refused port, and an `https://` URL pointed at a
  plaintext port were indistinguishable. Failures across all five HTTP DNS
  providers now name the cause and the fix. Upstream error bodies are also
  stripped of markup and capped rather than spliced into the message whole.
- **A WAF block now says so in the panel.** Blocked requests never reach the
  API, so there is no error envelope to render and both panels showed a bare
  status. They now recognise the block and report it as `WAF_REQUEST_BLOCKED`
  with a pointer to Security → WAF Events.

### Added
- **Allowlisted operator IPs are never blocked by the WAF, but are still
  logged.** The allowlist next to a WAF event writes a CrowdSec decision, which
  governs whether an IP is *banned*; ModSecurity inspects request *content* and
  had no IP concept at all, so an allowlisted address was still fully filtered.
  The reconciler now renders those entries as `ctl:ruleEngine=DetectionOnly`
  matched on `X-Real-Ip` — rules still evaluate and still record their matches,
  so allowlisted sources keep appearing in WAF Events and only ever lose the
  disruptive action. Fails closed: if CrowdSec is unreachable no bypass is
  rendered and the WAF stays fully enforced.

### Fixed
- **Admin and tenant sidebars are scrollable when the nav outgrows the viewport.**
  Both `<nav>` elements were `flex-1` inside a full-height flex column with no
  overflow handling, so on a short viewport — or in the admin panel with several
  groups expanded — the lower entries were simply unreachable. Both now scroll
  within the space left by the header and runtime block.

### Changed
- **Worker-subsystem guidance no longer opens with "drain and re-bootstrap".**
  The Cluster Nodes banner printed one unconditional line for every fault —
  *"tenant pods will fail to attach PVCs. Drain + re-bootstrap the worker"* —
  which was wrong twice: PVC attach is a CSI concern, so it misled whenever the
  fault was Calico (networking, and NetworkPolicy with it); and drain +
  re-bootstrap is a multi-minute outage for every workload on the node, offered
  as the *first* move for conditions that are usually a one-line fix. The banner
  now says what the failing subsystem actually affects, names the usual Calico
  cause (a missing host `iptables` package), and links to a new escalation
  ladder in the published manual — cheapest step first, drain last.

### Fixed
- **Calico stuck at `0/1 Ready` on fresh installs, with NetworkPolicy silently
  not being programmed.** Bootstrap installed `nftables` but not `iptables`. We
  do not use iptables — k3s bundles its own — but NetBird probes for the binary
  and, not finding it, falls back to writing NATIVE nft rules (`iifname "wt0"
  accept`, …) into `table ip filter`, the table Calico drives through
  `iptables-nft`. Felix then fails every dataplane resync with *"iptables-save
  failed because there are incompatible nft rules in the table"*, `calico-node`
  never leaves `0/1`, and policy stops being programmed. Tenant isolation
  depends on that policy, so this was a security regression rather than a
  cosmetic one. `iptables` is now part of the base package set, and
  host-migration 2026.8.2/0003 installs it on existing nodes and restarts
  NetBird so it re-creates its rules through the iptables backend.
  The install docs previously described the `Host iptables-save … not found`
  line as benign; that is true for k3s alone and was corrected.

### Changed
- **Longhorn no longer reserves 30% of a large root disk.** Its data path is the
  node's root filesystem, so reserving space there is right — filling it costs
  you the node, not just Longhorn. But 30% is the wrong *shape* of number: what
  it protects (OS, container images, logs) is roughly constant while a
  percentage scales with the disk, so a 500 GB root disk gave up 150 GB to
  protect a need that had barely grown. Reservation is now
  `10% + 20 GiB` — the 10% tracks kubelet's `nodefs.available<10%` eviction
  floor, below which Longhorn would schedule replicas into space kubelet treats
  as its own reserve and leave the node in DiskPressure that eviction cannot
  clear — then clamped to Longhorn's own 30%, so it can only ever REDUCE.
  A 500 GB root disk returns ~80 GB; 40/80 GB nodes are unchanged.
  Converged by host-migration 2026.8.2/0002.
- **Kubelet's pod ceiling raised from 110 to 500** (`max-pods`), fresh installs
  via a new bootstrap drop-in and existing nodes via host-migration
  2026.8.2/0001. 110 is a conformance figure, not a property of this platform;
  tenant pods request ~50m/64Mi and scale to zero, so nodes ran out of pod slots
  long before anything real. Safe on the IP side because Calico's IPPool uses
  blockSize 26 and grants nodes additional blocks on demand.

### Fixed
- **The completion screen told you where to log in, but not how.** Bootstrap's
  final summary printed the admin/tenant/API endpoints and never mentioned the
  seeded credentials; the one line that did (`Admin seed credentials written
  to …`) appeared ~700 lines earlier during secret generation and had long
  scrolled away. It now shows `sudo cat /etc/insula/admin-credentials` directly
  under the endpoints, and only when that file exists — a worker join, which
  seeds no admin, does not get an empty heading. The path shown is the branded
  one everywhere too: the write still goes through `/etc/platform` (an ADR-055
  compat symlink, same file) but the message no longer disagrees with the docs.

## [2026.8.1] - 2026-08-03

### Fixed
- **Seven `command not found` errors printed on every single install.** The Flux
  Kustomization is generated by an *unquoted* heredoc, so its body is subject to
  command substitution — including the explanatory comments inside it. Seven
  backticked spans in that prose (``op: remove /spec/instances``,
  ``kustomize build``, ``system-db``, …) were therefore executed as commands on
  every run, printing `bootstrap.sh: line 4718: op:: command not found` and six
  siblings to the operator's console. The generated YAML stayed valid (the
  substitutions sat inside comments, so only the words disappeared), which is
  why it shipped for months and read as upstream chatter. It was not harmless in
  principle: a backticked span naming a real command would have run it, as root,
  mid-install. Inline code in that block now uses single quotes. Six more
  instances of the same class — in `ingress-auth-e2e.sh`, `ingress-mtls-e2e.sh`
  and the VM harness — are fixed too, and a new guard
  `scripts/ci-heredoc-expansion-check.sh` (wired into Infrastructure CI) fails
  the build on any backtick inside an unquoted heredoc body.
- **The Stalwart probe no longer dead-ends the operator.** After 100 failed
  attempts it said "adminPassword probe returned unexpected 000 — refusing to
  bootstrap. Inspect pod state manually", which is both unactionable and
  misleading: `000` is a *connection* failure, not an unexpected auth response.
  It now says so, and prints the state that explains it — mail-namespace pods,
  PVCs, StorageClasses, `stalwart-mgmt` endpoints and recent events — plus the
  three usual causes in likelihood order (PVC Pending from a missing default
  StorageClass first, which is where a failed or skipped Longhorn step lands).
- **A single upstream 5xx during a chart pull no longer aborts the whole
  bootstrap.** `charts.longhorn.io` resolves its downloads to GitHub release
  assets, so a GitHub blip surfaced as `Error: failed to fetch …
  longhorn-1.12.0.tgz : 500 Internal Server Error` and, under `set -euo
  pipefail`, threw away ~20 minutes of successful install (reported by an
  operator 2026-08-03; the same URL served 200 shortly after). `helm_cmd` now
  retries up to `HELM_RETRY_ATTEMPTS` (default 3, 15s/30s backoff) **only** when
  helm's stderr matches a network-shaped failure — a rollout that never goes
  Ready, bad values or a quota block still fails on the first attempt, so a
  doomed `--wait --timeout 600s` is never tripled. Locked in by
  `scripts/test-bootstrap-helm-retry.sh` (14 checks, wired into Infrastructure
  CI), which asserts the fail-fast path as explicitly as the retry path.
- **Every `helm repo add` now passes `--force-update`.** Only the sealed-secrets
  call site had it. A plain `repo add` refuses to overwrite an existing entry's
  URL and the refusal is swallowed by `|| true`, so any host carrying a stale
  repo entry silently keeps resolving charts from the old URL — the exact
  failure already diagnosed once for sealed-secrets, now closed for traefik,
  jetstack, longhorn and cnpg too.
- **The CNI portmap self-test no longer cries wolf.** After recycling the local
  Traefik pod it waited 30s for the hostPort DNAT rule to reappear — but the
  graceful delete alone consumes 10s of that, leaving ~20s for schedule →
  image pull → container start → CNI ADD, which a fresh or loaded node
  routinely overruns. Raised to 120s (it returns the moment the rule appears,
  so a healthy node pays nothing), and the warning now hands over a concrete
  diagnosis — including the `curl 127.0.0.1` probe that distinguishes a real
  breakage from a probe that simply can't see an iptables-nft-rendered rule.

### Changed
- **Install docs: state the tools you need, and stop leading with a cosign
  command that warns.** The getting-started pages never said `curl` had to be
  present before the first download (it isn't, on minimal Debian), and the
  verification step used `cosign verify-blob`, which on cosign v3 emits
  `WARNING: Skipping tlog verification is an insecure practice…` plus a
  `--signature has been deprecated` notice — alarming output in the middle of a
  first install. Requirements now lists the pre-install tools (`curl`,
  `openssl`, `base64`) with apt/dnf one-liners, and verification leads with
  `openssl dgst -sha256 -verify` — no extra install, no warnings, and the exact
  check `platform-ops` already performs on every self-upgrade. The cosign route
  is kept as a documented alternative that explains why
  `--insecure-ignore-tlog=true` is mandatory (releases are signed with an
  offline key and are deliberately not in Rekor) and what that does and does not
  cost you. Same correction applied to the README quickstart, multi-node join,
  `DEPLOYMENT_RUNBOOK.md`, and `PRODUCTION_PREFLIGHT_CHECKLIST.md`.

## [2026.7.27] - 2026-07-30

### Fixed
- **Tenant restore could self-grant the custom-container entitlement.** The
  per-tenant `allow_custom_containers_override` column (added in v2026.7.26,
  migration 0078) was missing from the tenant-restore deny-list, so a tenant
  restoring the `tenants` table from a bundle could flip it on. Added to
  `DEFAULT_TENANT_RESTORE_POLICY`, same class as the other operator-only
  `*_override` caps.
- **`sync-development-changelog` (post-release CHANGELOG reconcile) is robust
  again.** It hard-failed with `python3: Argument list too long` once the
  CHANGELOG crossed Linux's 128 KB single-argument limit (at v2026.7.26) — it
  passed the whole file as an argv; now streamed via a temp file. Also fixed the
  long-latent dedup that only matched single-line `**bold**` titles, leaving
  multi-line titles and non-bold bullets (e.g. dependency bumps) drifting in
  `[Unreleased]`; it now dedups by normalised full-entry text (regression-tested).
- **`cut-release.sh` no longer hard-fails when copied without its `lib/`.** Its
  dependency preflight sources `scripts/lib/require-tools.sh` defensively.

## [2026.7.26] - 2026-07-30

### Added
- **"Allow Custom Containers" subscription toggle (ADR-036 gating).** Bring-your-own
  container deployments are now gated per subscription: a plan-level
  `allow_custom_containers` flag (default **off** for every plan) with a nullable
  per-tenant override (`allow_custom_containers_override`, resolved `override ??
  plan`). When a tenant's effective access is off, the tenant panel hides the
  **Custom Containers** tab (existing custom deployments stay visible/manageable
  under *Installed Apps*) and the backend refuses new custom deploys with
  `CUSTOM_CONTAINERS_NOT_IN_PLAN`. Layered on the existing system-wide
  `customDeploymentsEnabled` kill-switch — both must be true. Admin controls: a
  checkbox on the plan form and a per-tenant override toggle on the tenant-detail
  Resource Limits card. Migration 0078.
- **Admins can disable individual catalog apps.** Alongside *featured*/*popular*, a
  new `disabled` flag hides a catalog entry from the tenant catalog listing (admins
  still see it — dimmed card, "Disabled" badge, eye toggle) and blocks new deploys
  of it (`CATALOG_ENTRY_DISABLED`); existing deployments keep running untouched.
  Migration 0078.

### Fixed
- **The dev/dind overlays no longer block the whole platform namespace with a
  stale `limits.cpu` quota.** `platform-quota` in `k8s/overlays/development` and
  `k8s/overlays/dind` still tracked `limits.cpu` (20 / 4) — left over from the
  pre-2026-06-24 CPU-limited model — but platform pods run *without* CPU limits
  (ADR-037), so every pod (management API, panels, CNPG initdb) was rejected with
  `must specify limits.cpu` and nothing scheduled. Removed `limits.cpu` from both
  overlay quotas (matching the base) and dropped the development overlay's
  `platform-limit-range` `default.cpu`/`max.cpu` so dev/staging match production.
- **Scripts fail fast with an install one-liner when a required tool is missing.**
  New `scripts/lib/require-tools.sh` (`require_cmds …`) is preflighted at the top
  of `local.sh` (docker/helm), `smoke-test.sh` (curl/jq) and `cut-release.sh`
  (git/python3) — so e.g. a missing `helm` fails instantly with
  `curl … get-helm-3 | bash` instead of dying deep inside the k3s bringup after
  the docker builds already ran.
- **Dependabot opened its PRs against `main`.** The config set no
  `target-branch`, so it defaulted to the repository default branch — but under
  ADR-053 `main` only ever receives `chore(promote)` tree-snapshots of
  `development` plus `chore(release)` commits, so a bump merged into `main` is
  silently reverted by the next promote. All eight ecosystem blocks now target
  `development`.

### Changed
- `lucide-react` 1.26 → 1.27 (supersedes the Dependabot PR that was targeting
  `main`). All 161 icons imported across the repo still resolve in 1.27.0.

## [2026.7.25] - 2026-07-29

### Changed
- Maintenance release — validation target for the honest upgrade-completion
  fix; no functional change since v2026.7.24.

### Fixed
- **The upgrade progress bar / "Done" no longer runs ~30–40 s ahead of the actual
  roll.** A Deployment was counted "at target" as soon as Flux re-pinned its
  template and `availableReplicas` was satisfied — but during a rolling update the
  *old* pod satisfies availability, so the bar hit 100% and the modal said "Done"
  before the new-version pods were serving (while the Task Center row was still
  correctly running). Completion now requires the roll to be genuinely done
  (`updatedReplicas == replicas == desired`, no old surge pod left), so the modal's
  "Done" lines up with the task finalizing.
- **A cluster's FIRST upgrade to the adaptive reconciler no longer waits out a
  stale lease.** The upgrade reconciler's single-flight lease is now reclaimable
  when its stored expiry is further out than any legitimate TTL — otherwise the
  108s lease written by the prior (fixed-cadence) release blocked the new fast
  reconciler for the whole first upgrade (~90s finalize lag on the transition).

## [2026.7.24] - 2026-07-29

### Fixed
- **The upgrade progress bar / "Done" no longer runs ~30–40 s ahead of the actual
  roll.** A Deployment was counted "at target" as soon as Flux re-pinned its
  template and `availableReplicas` was satisfied — but during a rolling update the
  *old* pod satisfies availability, so the bar hit 100% and the modal said "Done"
  before the new-version pods were serving (while the Task Center row was still
  correctly running). Completion now requires the roll to be genuinely done
  (`updatedReplicas == replicas == desired`, no old surge pod left), so the modal's
  "Done" lines up with the task finalizing.
- **A cluster's FIRST upgrade to the adaptive reconciler no longer waits out a
  stale lease.** The upgrade reconciler's single-flight lease is now reclaimable
  when its stored expiry is further out than any legitimate TTL — otherwise the
  108s lease written by the prior (fixed-cadence) release blocked the new fast
  reconciler for the whole first upgrade (~90s finalize lag on the transition).

## [2026.7.23] - 2026-07-29

### Fixed
- **A cluster's FIRST upgrade to the adaptive reconciler no longer waits out a
  stale lease.** The upgrade reconciler's single-flight lease is now reclaimable
  when its stored expiry is further out than any legitimate TTL — otherwise the
  108s lease written by the prior (fixed-cadence) release blocked the new fast
  reconciler for the whole first upgrade (~90s finalize lag on the transition).

## [2026.7.22] - 2026-07-29

### Fixed
- **Platform upgrade: the Task Center row now tracks the roll faithfully.** The
  redesigned modal reported "Done" from the live roll within ~30 s, but the task
  stayed *running* for ~4 min, its dropdown progress bar sat at 0%, and the
  dashboard kept the old version + "update available" banner for ~1 min after
  reload. Fixed end-to-end:
  - The post-flight reconciler runs on an **adaptive cadence** — ~8 s while an
    upgrade is in flight (was a fixed 2 min + 100 s initial delay) — writing the
    live per-Deployment `progressPct` onto the task each tick and **finalizing
    within seconds of convergence**. The abort-streak (stuck detection) is
    decoupled onto a slow 2-min sub-cadence so the fast tick rate can't false-trip
    "not converging" during a normal roll.
  - `updateAvailable` is computed against the **higher of the running env and the
    durable `installed_platform_version`**, so once the new version's pod boots the
    banner clears immediately — even if an old pod is momentarily still serving the
    read during the roll.
  - The progress modal invalidates the version + post-flight queries on **Done**,
    so the badge/banner refresh without waiting out the 60 s cache.
- Removed the duplicate **Upgrades** item from the Platform Settings menu (the page
  consolidated into **Updates**; `/platform/upgrades` stays a redirect).

## [2026.7.21] - 2026-07-29

### Fixed
- **Tenant resource usage reported CPU reserved as 0 and PVC usage as 0.**
  Three independent causes, all in the per-tenant metrics collector:
    - *CPU reserved* was summed from `container.resources.limits.cpu`, but
      tenant workloads run asymmetric QoS (ADR-037) — CPU **request** only, no
      CPU limit — so the field was unset on every container and the total was
      structurally always 0. Memory looked correct because its request equals
      its limit, which is why only some figures looked wrong. Now summed from
      requests, falling back to limits; the ResourceQuota fallback path had the
      same bug and got the same fix.
    - *PVC usage* came solely from the file-manager sidecar's `/disk-usage`.
      That sidecar is created at `replicas: 0` and scaled back to 0 after 10
      minutes idle, so the probe usually failed and usage silently read 0. It
      now comes from `kubelet_volume_stats_used_bytes` (new `kubelet-volumes`
      scrape job — CSI-agnostic, two series per PVC), with the file-manager
      kept as a fallback for the case the kubelet cannot cover: a tenant whose
      every workload is stopped has no mounted volume to report on.
    - *Staleness*: the endpoint served a cached sample and refreshed **behind**
      the response, so the panel showed the previous value and needed a second
      reload to catch up — on top of a scheduler that only refreshed hourly. It
      now returns a cached sample only while it is under 15s old and otherwise
      collects synchronously, so the page and the resource modal (which share
      the endpoint) show live state, polled every 60s while the tab is active
      and on demand via Refresh.
- **Admin-panel lint hard-failed on an inert eslint directive.** An
  `eslint-disable-next-line react-hooks/exhaustive-deps` in `UpgradeReviewModal`
  named a rule this repo does not configure, so eslint errored with "Definition
  for rule … was not found" and turned `development` red. The directive
  suppressed nothing; replaced with a comment recording why the effect is
  mount-only.
- **Monitoring tabs sat flush against the card border.** The page renders each
  tab panel straight into the card with no padding wrapper, so every tab has to
  supply its own — SLOs, Mail and Node Health supplied none. All six content
  tabs now share `p-5` (Pods moved from `p-4` for consistency); the two alert
  tables stay full-bleed, which is intended for a table inside a card.

### Changed
- **Monitoring now opens on the SLOs tab** instead of Active Alerts — SLOs
  answer "is the platform meeting its objectives right now", where Active Alerts
  only shows what has already fired. An explicit `?tab=` still wins, so existing
  deep links (e.g. the `/monitoring/health` redirect) are unaffected.
- **SLO rules table is now sortable**, defaulting to most-recently-evaluated
  first. **State moved to the first column** and its icons are now filled pills
  rather than inline text, so the leftmost column reads at a glance. Sorting uses
  derived keys — a numeric `evaluatedTs` (never-evaluated rules sort to the
  bottom instead of floating to the top as nulls would) and a `stateRank` that
  orders firing → ok → disabled.
### Added
- **Per-route HSTS, configurable in the tenant panel** (Route → Advanced → HSTS):
  enable, `max-age`, `includeSubDomains`, `preload`. Emitted at the edge as a
  Traefik `headers` Middleware rather than by the workload image — the Official
  Catalog runtimes deliberately send no `Strict-Transport-Security` of their own,
  so a tenant can switch runtime or bring their own container without silently
  losing or gaining the policy. **Off by default on every route**, including
  existing ones: HSTS is sticky and cannot be recalled from the server, so it is
  opt-in per route. The header is only ever sent on HTTPS responses (Traefik's
  `forceSTSHeader` is never set). The Middleware is ordered first in the chain so
  short-circuiting responses — allowlist 403, rate-limit 429, redirects, custom
  error pages — still carry it. `preload` is refused unless `includeSubDomains`
  is on and `max-age` ≥ 1 year, validated in the panel, against the merged row in
  the service, and by a CHECK constraint in migration `0077`. See
  [docs/features/HSTS.md](docs/features/HSTS.md).

## [2026.7.20] - 2026-07-28

### Fixed
- **Platform-upgrade progress/post-flight reported a phantom perpetual upgrade to
  the last-completed version.** After a healthy convergence the in-flight marker
  (`pending_update_version`) is cleared, but the persisted post-flight state blob
  stayed frozen at `{phase: healthy, pendingVersion: <that version>}` and the
  scheduler went dormant — so `/upgrade/progress` and `/upgrade/postflight` kept
  reporting an upgrade to the old target (progress bar stuck at 0/N, modal stuck
  on "Rolling → <old>…"). `readPostflightState` now reconciles against the live
  marker: with no pending upgrade it reads `idle`, and while one is in flight it
  pins `pendingVersion` to the live marker (fresh, not one scheduler-tick stale).
  Also, while an upgrade is in flight but the reconciler has not yet written its
  first assessment (the ~100 s after Apply, or a cluster's first-ever upgrade) it
  now reports `reconciling`, not `idle`, so the just-opened progress modal shows
  the roll instead of flashing "Done".

## [2026.7.19] - 2026-07-28

### Fixed
- **Platform-upgrade progress/post-flight reported a phantom perpetual upgrade to
  the last-completed version.** After a healthy convergence the in-flight marker
  (`pending_update_version`) is cleared, but the persisted post-flight state blob
  stayed frozen at `{phase: healthy, pendingVersion: <that version>}` and the
  scheduler went dormant — so `/upgrade/progress` and `/upgrade/postflight` kept
  reporting an upgrade to the old target (progress bar stuck at 0/N, modal stuck
  on "Rolling → <old>…"). `readPostflightState` now reconciles against the live
  marker: with no pending upgrade it reads `idle`, and while one is in flight it
  pins `pendingVersion` to the live marker (fresh, not one scheduler-tick stale).

## [2026.7.18] - 2026-07-28

### Changed
- **Static-site catalog codes renamed `static-nginx` → `nginx` and
  `static-apache` → `apache`.** The code is what the tenant panel pre-fills as
  the deployment name and what the storage path is built from, so it should read
  as the web server, not as an internal category. Migration `0076` renames the
  rows **in place** so existing deployments keep their `catalog_entry_id`; the
  catalog folders and GHCR image paths are unchanged. Requires the matching
  manifest change in `insulahq/application-catalog`.

## [2026.7.18] - 2026-07-28

### Changed
- **Redesigned the platform update page.** "Run upgrade" moved into the version
  card (shown only when a newer verified release is available) → a Review modal
  (pre-flight + interruption preview) → Approve (no second confirm) → a live
  progress modal; removed the standalone Run-upgrade / Pre-flight cards. The
  progress modal now shows a clear **Done** state (it was stuck on "Rolling…" for
  up to 2 min after finishing) and a **per-component phase** (Downloading /
  Deploying / Ready) derived from each Deployment's pods. It keeps polling through
  the admin-panel + API restart mid-upgrade (a "Reconnecting…" hint + a
  post-upgrade "Reload admin panel" action) so progress never freezes until a
  manual reload. The available version is highlighted green when an update exists.
- **Static-site catalog codes renamed `static-nginx` → `nginx` and
  `static-apache` → `apache`.** The code is what the tenant panel pre-fills as
  the deployment name and what the storage path is built from, so it should read
  as the web server, not as an internal category. Migration `0076` renames the
  rows **in place** so existing deployments keep their `catalog_entry_id`; the
  catalog folders and GHCR image paths are unchanged. Requires the matching
  manifest change in `insulahq/application-catalog`.
- **Deploy modal pre-fills `my-<code>` as the deployment name** (e.g.
  `my-nginx`) instead of echoing the catalog code back at the tenant. Applies to
  every catalog deployment; the uniqueness suffix (`-2`, `-3`, …) is unchanged.
- **The `nginx` static runtime now defaults to 32Mi memory** (was 64Mi), min and
  recommended. A single-component deployment takes its budget verbatim, so the
  allocator's 64Mi per-component floor does not apply.

### Added
- **Custom Apache configuration via `APACHE_CONF_DIR`**, mirroring the nginx
  `NGINX_CONF_DIR` mechanism: point it at a folder in tenant storage and its
  `*.conf` are included into the main server config, the folder is seeded with a
  README, and it is never web-served. Unlike nginx, the Apache entrypoint runs
  `httpd -t` first — an invalid tenant config is ignored (site restarts on the
  default config) rather than crash-looping the pod, with the reason logged.

### Fixed
- **Optional configurable env vars were unreachable after deploy.** The installed
  app's Configuration section listed only keys already present in the stored
  configuration, so a variable whose default is empty (`NGINX_CONF_DIR`,
  `APACHE_CONF_DIR`) rendered "No custom configuration" with no way to add it.
  It now also lists catalog-declared configurable keys that are unset (shown as
  *not set*), and empty values are not persisted.

## [2026.7.17] - 2026-07-28

### Changed
- Maintenance release — no functional changes since v2026.7.16; re-pinned as a
  fresh signed release (e.g. to exercise the upgrade flow from an installed
  cluster).

## [2026.7.16] - 2026-07-28

### Fixed
- **Platform update card wrongly read "no releases published".** It showed
  `latestVersion` (the lazy, unverified GitHub check — null on production) instead
  of the cosign-verified `available` release the poller confirms. The card now
  prefers `available`, so it correctly shows the latest verified version (and
  warns inline on a non-verified verify status).

## [2026.7.15] - 2026-07-28

### Changed
- **The platform update/upgrade UI is now a single page.** `/platform/updates`
  and `/platform/upgrades` merged into one page (version + settings + deployed
  images on top of pre-flight → interruption preview → apply → live progress →
  rollback). `/platform` defaults there; upgrade/rollback actions are gated to
  super-admin inside the page (admins see the read-only version/settings view).
- **Full dark-mode support** on the consolidated page (every card, gate, input,
  button, progress bar, and panel now has a `dark:` variant).

### Fixed
- **Rollback now shows progress + a Task Center task, like an upgrade.** An
  applied rollback records the roll-back target as `pending_update_version` and
  enrols a `platform.upgrade` task, so it drives the same post-flight / live
  roll-progress / Tasks-chip machinery (was: a silent re-pin with no progress).

## [2026.7.14] - 2026-07-28

### Changed
- **"Update Now" now actually upgrades the platform.** The dashboard banner + the
  Updates page fired the legacy push-model endpoint (`POST /admin/platform/update`
  → set `pending_update_version`, expecting a CronJob to run `flux reconcile`),
  which never re-pins the tag → a silent no-op on the production pull model
  ("Update started", but nothing happened, no progress, no task). Consolidated
  onto the ADR-045 re-pin flow: the banner + Updates page now route super-admins to
  the Upgrades page (pre-flight → interruption preview → confirm → live progress),
  and `/platform` defaults there for super-admins. An applied upgrade now enrolls a
  **re-openable Task Center task** (`platform.upgrade`) with a live progress modal,
  finalized on convergence by the post-flight reconciler. Removed the dead
  push-model path entirely: `POST /admin/platform/update`, `service.triggerUpdate`,
  the `useTriggerUpdate` hook, and the suspended `platform-update-checker`
  CronJob + RBAC.

### Fixed
- **Stalwart web-admin was unreachable (401) on staging & production.** The
  admin panel iframes/opens the Stalwart web-admin at `stalwart.<apex>`, gated
  by the `admin-auth-cookie` auth_request — but `platform_session` was issued
  host-only to `admin.<apex>`, so a browser never sent it to the `stalwart.<apex>`
  subdomain and the gate 401'd for every operator (dev/dind were unaffected —
  they already share the cookie). Set `session-cookie-domain: ".${DOMAIN}"` in
  the production overlay's `platform-config` (staging inherits via
  `../production`) so the cookie is `Domain=.<apex>; SameSite=None; Secure`.
  CSRF-safe: all mutating endpoints are Bearer-only. Added a deterministic CI
  guard (`ci-session-cookie-domain-check.sh`) and an end-to-end reachability
  suite (`integration-stalwart-webadmin-auth.sh`) so it can't regress.

## [2026.7.12] - 2026-07-28

### Fixed
- **Admin dashboard reported `v0.1.0` for every cluster.** `GET /api/v1/admin/status`
  returned a hardcoded `version: '0.1.0'`, and the dashboard version badge reads that
  endpoint — so the platform version shown was always `v0.1.0` regardless of the deployed
  release, even though `PLATFORM_VERSION`, `/auth/runtime-info`, and `/admin/platform/version`
  were all correct. It now reports the running `PLATFORM_VERSION`.

## [2026.7.11] - 2026-07-28

### Changed
- **Hardened the platform-upgrade end-to-end integration test**
  (`scripts/integration-platform-upgrade.sh`). It now asserts the apply returned
  `applied: true` rather than merely HTTP 200 — so a graceful W16 rescue-capture
  abort (200 + `applied: false`: the safety net correctly refusing to re-pin
  without a rescue snapshot while Longhorn is still settling) can no longer be
  misread as a successful re-pin — retries that transient abort, and
  transparently re-mints the bearer token so a roll that outlives the 30-minute
  JWT TTL doesn't fail the run mid-way through the rollback phase. Test tooling
  only; no runtime/product code changed since 2026.7.10.

## [2026.7.10] - 2026-07-28

### Security

Findings from a full-repo security review (2026-07-28). Two were exploitable;
the rest are hardening. No evidence of exploitation — staging and DEV were the
only clusters running the affected code.

Follow-up (same day): wired 9 previously-unwired `ci-*.sh` guards into
Infrastructure CI after validating each, plus a real fix and two repairs found
while doing so.

- **Tenant restore could reset operator-set limit overrides (real gap, found by
  wiring `ci-tenant-restore-policy-check`).** The tenant-restore deny-list had
  drifted: `tenants.bandwidth_limit_override`, `max_mailbox_size_mb_override`,
  and `bandwidth_capped_at` (added by the bandwidth-cap and mailbox-limit
  features) were NOT denied, so a tenant restoring an old backup of their own
  row could lift a bandwidth cap or inflate their mailbox-size limit. Added to
  `DEFAULT_TENANT_RESTORE_POLICY.deniedColumnsByTable['tenants']`. The guard now
  runs in CI so the deny-list can't silently drift again.
- **`ci-no-secret-in-argv` repurposed.** Its only target file (`blob-store.ts`)
  was retired in #205, so the guard threw "file not found" and could only fail.
  Rewritten to scan the whole backend for a credential assigned to a cli arg as
  anything other than a `$SHELL_VAR` (JS interpolation / hardcoded literal), so
  it protects the invariant wherever an argv might reappear.
- **`ci-stalwart-check` / `ci-webmail-feature-css-check` overlay paths fixed.**
  Both referenced the old `dev/` overlay (renamed to `dind/`), so they silently
  skipped or hard-failed. Repointed to `dind/` and verified each overlay builds.
- **npm advisories cleared: production `npm audit` 0 (was 36 high).** The
  `dompurify` override was bumped 3.4.8 → 3.4.12 (its own #267 CVE fix is now
  superseded — GHSA-c2j3-45gr-mqc4 et al.) and `brace-expansion` overridden to
  `^5.0.8` (GHSA-mh99-v99m-4gvg, the mjml → js-beautify chain). The previous
  attempt's overrides were silently ignored because `npm install` reuses the
  existing lock without re-resolving; a from-scratch lock regen applies them.
  That regen also floated `@emnapi/*` to a `2.0.0-alpha` prerelease, so those
  are pinned back to `^1.11.1`. Net lock change: 29 in-range patch/minor bumps,
  no majors, no prereleases. Full typecheck + both frontend builds + 5822
  backend + 623 panel tests green. `ci-stalwart-hostname-check` and
  `ci-no-leaked-test-tenants` are cluster-runtime checks (the latter already
  runs in `integration-all.sh`); the former's invariant was verified to hold
  live on staging but it can only run in-cluster, so it stays an operator tool.

- **Passkey second-factor could be bypassed with the password alone (HIGH).**
  `/auth/login` withholds session tokens when a user has `passkeyMode =
  second_factor` and returns a short-lived pre-auth token carrying
  `step: 'passkey_2fa'`. Only `passkey-routes.ts` and `step-up-routes.ts`
  checked that claim — the shared `authenticate` middleware and the four
  `request.jwtVerify()` handlers in `authRoutes` accepted a pre-auth token as a
  full session token. Because `PATCH /auth/password` returns a real refresh
  token, an attacker who knew the password could trade the pre-auth token for a
  refresh token and then a full access JWT, never presenting the passkey. The
  check now lives in `assertAccessToken()` in `middleware/auth.ts` and is
  applied by `authenticate`, by the new `verifyAccessToken()` used by every
  inline-verify handler, and by both raw-WebSocket verifiers.
- **Cross-tenant file read through the AI editor (HIGH).**
  `POST /tenants/:tenantId/ai/edit` and `GET /tenants/:tenantId/ai/budget` ran
  with `onRequest: [authenticate]` and no tenant scoping, so `tenantId` was an
  attacker-chosen path segment. In `folder-execute` mode the caller supplies
  `operations` verbatim; the handler resolved the *victim's* namespace, read
  files through their file-manager sidecar (creating one if absent) and returned
  the file contents in `changes[].originalContent`. Both routes now use
  `requireTenantAccess()` + `requireTenantRoleByMethod()`.
- **container-console authorization gaps (MEDIUM).** `GET
  /tenants/:tenantId/deployments/:deploymentId/components` had neither a role
  nor a tenant check (any authenticated user could enumerate any tenant's
  pod/container topology), the log-stream WebSocket had no role check (the
  admin-panel reporting roles `billing` / `read_only` could stream any tenant's
  container logs), and the module's local `enforceTenantAccess()` failed OPEN
  for a tenant-panel token with no `tenantId` claim — the same hole
  `middleware/auth.ts` closed for the shared helper but which this copy never
  received. All three fixed; the local helper now mirrors the middleware.
- **`PLATFORM_ENCRYPTION_KEY` no longer falls back to an all-zero key
  (MEDIUM).** A missing key in production previously logged CRITICAL and carried
  on, "encrypting" DNS-provider credentials, OIDC client secrets, backup-target
  secrets and mTLS keys under a publicly known key. `loadConfig()` now refuses
  to start when `PLATFORM_ENV` is `production` or `staging` and the key is
  missing, and rejects a malformed key (must be 64 hex chars) in every
  environment — `Buffer.from(key, 'hex')` silently truncates, which previously
  turned a bad key into per-request runtime failures instead of a boot failure.
- **Panel security headers (MEDIUM).** The tenant panel served **no** security
  headers at all (framable by any origin); the admin panel served only
  `frame-ancestors`. Both now emit `Content-Security-Policy: frame-ancestors
  'self'`, `X-Frame-Options`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy` and — on https requests only — HSTS
  (`NGINX_HSTS_MAX_AGE`, default 1 year, set `0` to disable). Shipped as
  `frontend/security-headers.conf` and `include`d at server level *and* inside
  every `location` that sets its own `add_header`, because nginx replaces
  rather than merges inherited headers.
- **Bootstrap no longer pipes unverified remote scripts into a root shell
  (MEDIUM).** k3s, Helm and Flux were installed via `curl | sh` with no
  integrity check, and the Helm one was fetched from the `main` *branch*. Each
  is now pinned (Helm to the `v3.20.0` tag) and verified against a sha256
  recorded in `bootstrap.sh` before it executes; a mismatch aborts the install.
  Not an infra version pin — no host-migration required.
- **Supply chain (MEDIUM).** Third-party GitHub Actions are pinned to commit
  SHAs (several ran in jobs holding `packages: write` / `id-token: write` for
  cosign signing); the six workflows that inherited the repository-default token
  now declare `permissions: contents: read`.
- **Bounded `trustProxy` (MEDIUM, defense-in-depth).** Fastify ran with
  `trustProxy: true`, which adopts the left-most — client-writable —
  `X-Forwarded-For` entry into `request.ip`, the key for the unauthenticated
  login rate limit and the recorded audit-log source IP. Verified against
  staging that this is *not* currently exploitable: Traefik's
  `forwardedHeaders.trustedIPs=127.0.0.1/32` strips client-supplied forwarded
  headers (five spoof variants all audited the true client IP). Narrowed anyway,
  because that protection lives one layer up and widening Traefik's trusted IPs
  is the documented way to front the cluster with an external load balancer.
  Trust is now the RFC1918 super-set the panel nginx templates already use,
  overridable via `PLATFORM_TRUSTED_PROXY_CIDRS`.
- **`archiver` 5.3.2 → 8.0.0 and unused `archiver-zip-encrypted` removed.**
  Clears the vulnerable `readdir-glob → minimatch → brace-expansion` chain
  (GHSA-mh99-v99m-4gvg) — 54 packages out of the production tree, 6 of them
  carrying the advisory, with no unrelated version churn. archiver 8 is ESM and
  replaced its factory with named classes, so `streamZipExport` now supports
  both shapes; ZIP output verified extractable with a stock `unzip`.

### Added
- `scripts/ci-tenant-scope-check.sh` — CI guard asserting every
  `/tenants/:tenantId/` route is scoped to the caller's tenant (via
  `requireTenantAccess()`, a staff-only role gate, or an allowlist entry with a
  written reason). It caught a third module (`email-dkim/rotate-routes.ts`)
  whose hand-rolled check did not fail closed on a missing `tenantId` claim.

### Fixed
- **`ci-node-terminal-check.sh` had been failing on `development` and nothing
  noticed** — its Pino-redact assertion stopped matching when a `jwt`
  alternative was added to the redact regex. The guard was not wired into any
  workflow. Fixed, and it plus `ci-secrets-denylist-check.sh` are now wired into
  Infrastructure CI. 11 other `ci-*.sh` guards still never run; tracked as
  follow-up.

### Fixed
- **Tenant backup/restore Jobs could not reach the backup-rclone-shim (regression
  in 2026.7.7/2026.7.8).** The tenant-egress default-deny excepts the cluster
  service CIDR, and the initial `allow-backup-jobs-egress` policy only opened
  platform-api:3000 — but restic actually backs up to / restores from the
  `backup-rclone-shim` S3-compatible endpoint on :9000 (which proxies to the
  operator's real target). So restic hung on `dial tcp <shim>:9000: i/o timeout`,
  every backup/restore/DR flow failed `partial`, and the hung Jobs pinned RWO
  volume attachments — cascading into tenant-provisioning timeouts across the
  integration suite. The policy now also allows egress to
  `backup-rclone-shim:9000`, scoped to the backup/restore component label.

## [2026.7.9] - 2026-07-28

### Fixed
- **Tenant backup/restore Jobs could not reach the backup-rclone-shim (regression
  in 2026.7.7/2026.7.8).** The tenant-egress default-deny excepts the cluster
  service CIDR, and the initial `allow-backup-jobs-egress` policy only opened
  platform-api:3000 — but restic actually backs up to / restores from the
  `backup-rclone-shim` S3-compatible endpoint on :9000 (which proxies to the
  operator's real target). So restic hung on `dial tcp <shim>:9000: i/o timeout`,
  every backup/restore/DR flow failed `partial`, and the hung Jobs pinned RWO
  volume attachments — cascading into tenant-provisioning timeouts across the
  integration suite. The policy now also allows egress to
  `backup-rclone-shim:9000`, scoped to the backup/restore component label.

## [2026.7.8] - 2026-07-27

### Fixed
- **Tenant backup/restore Jobs blocked from platform-api by the new
  tenant-egress policy (regression in 2026.7.7).** The `tenant-egress`
  default-deny added in 2026.7.7 excepts the cluster service CIDR, which also
  cut off the backup/restore Jobs that run in the tenant namespace and stream
  bundle components to platform-api's `/internal/bundles` endpoints over its
  ClusterIP — so every backup/restore broke. A new
  `allow-backup-jobs-egress-to-platform-api` NetworkPolicy, scoped to the
  `platform.io/component: backup-files|restore-files` label, restores egress to
  platform-api:3000 for those Jobs only (mirrors the existing ingress rule).

## [2026.7.8] - 2026-07-27

### Fixed
- **Tenant backup/restore Jobs blocked from platform-api by the new
  tenant-egress policy (regression in 2026.7.7).** The `tenant-egress`
  default-deny added in 2026.7.7 excepts the cluster service CIDR, which also
  cut off the backup/restore Jobs that run in the tenant namespace and stream
  bundle components to platform-api's `/internal/bundles` endpoints over its
  ClusterIP — so every backup/restore broke. A new
  `allow-backup-jobs-egress-to-platform-api` NetworkPolicy, scoped to the
  `platform.io/component: backup-files|restore-files` label, restores egress to
  platform-api:3000 for those Jobs only (mirrors the existing ingress rule).
- **`GET /api/v1/regions` restored to a public reference-data endpoint.**
  2026.7.7 hardened the M5 finding by requiring authentication, but `/regions`
  (like `/plans`) is public reference data used by the create-tenant/signup
  flow, and gating it broke that contract + the post-deploy smoke check. The
  actual finding — an anonymous caller learning the API-server address — is
  fully fixed by dropping the internal `kubernetes_api_endpoint` column from the
  response (retained), so the endpoint is public again with the sensitive field
  removed.

## [2026.7.7] - 2026-07-27

### Security
- **Medium/low findings from the 2026-07-27 review.**
  - `GET /api/v1/regions` now requires authentication and no longer returns the
    internal `kubernetes_api_endpoint` column (was anonymous, leaking the API
    server address).
  - Both panel nginx configs refuse `/api/v1/internal/*` at the edge — those
    routes are for in-cluster callers only (they reach platform-api via its
    ClusterIP Service), so no internal endpoint is reachable from the public panel.
  - The node-terminal WebSocket `?jwt=` access token is now redacted from access
    logs (only `token`/`replica` were before).
  - **Tenant workloads + the file-manager sidecar no longer mount a ServiceAccount
    token** (`automountServiceAccountToken: false`) — they never call the
    Kubernetes API, so this removes a credential that could be exfiltrated and
    replayed, and makes tenant→apiserver network reachability inert.
  - The file-manager `?token=` query-param → Authorization shortcut is restricted
    to GET/HEAD (a bearer token in a URL leaks into logs/Referer/history; writes
    must send a real header).
  - The interactive Swagger UI (`/api/docs`) is no longer served in production.
  - The sftp-gateway's per-username auth lockout was removed — a third-party-
    triggerable account lockout is a denial-of-service anti-pattern; per-source-IP
    throttling + bcrypt remain the brute-force defences.
  - Deferred (documented in ROADMAP R11): per-tenant hostPort PSA opt-in, rsync
    flag allowlist, rate-limit key hardening.
- **Tenant network isolation hardened (critical).** The per-tenant
  `default-deny-ingress` and `allow-platform-api` NetworkPolicies carried an
  `ipBlock: 10.42.0.0/16` — the whole k3s pod CIDR — alongside their
  namespaceSelector. That matched *every* pod in the cluster, so tenants were
  not isolated from each other: any tenant container could reach another
  tenant's pods, and the file-manager sidecar's root file API on `:8111` was
  reachable cluster-wide. The ipBlock was a stale workaround for the old
  hostNetwork ingress-nginx; Traefik runs hostPort and Calico preserves its pod
  source IP cross-node (verified live), so the namespaceSelector alone is
  correct. The ipBlock is removed and `:8111` is scoped to the platform-api pod.
- **Tenant egress default-deny added.** Every tenant namespace now gets a
  `tenant-egress` NetworkPolicy allowing DNS, intra-namespace traffic, and the
  public internet *minus* the cluster pod/service CIDRs and the cloud metadata
  IP (`169.254.169.254`). Tenant containers can no longer reach the Longhorn /
  CNPG / cert-manager APIs or cloud metadata; outbound internet and
  `mail.<apex>` (public) still work. CIDRs read from `platform-cluster-cidrs`
  with sane k3s defaults.
- **File-manager sidecar now authenticates every request (defense in depth).**
  `:8111` required no request auth (it relied entirely on the — broken —
  NetworkPolicy). It now requires the per-tenant derived secret in
  `X-Platform-Internal` on every route except `/health`; `.platform` hidden
  paths are never exposed over HTTP.
- **Webcron SSRF closed (H-4).** The tenant-configured webcron URL was fetched
  from platform-api with no destination check and the response reflected back.
  Outbound webcron fetches now go through an SSRF guard that refuses internal /
  loopback / link-local / CGNAT / metadata destinations at connect time
  (DNS-rebind safe) and only allows http/https.
- Existing tenants converge on the new policies via a boot-time reconciler
  (`reconcileAllTenantNetworkPolicies`), no reprovision required.

### Removed
- **PHP sendmail-compat credential provisioning (mail-submit).** Obsolete and
  never production-tested. Apps that send mail configure an external SMTP relay
  or the platform mail server (`mail.<apex>`, ports 587/465) with a mailbox's
  credentials directly. The `mail_submit_credentials` table is retained
  (non-destructive) so older backup bundles restore cleanly.

## [2026.7.6] - 2026-07-26

### Fixed
- **Calico Installation placement reconcile** (`system-pod-placement`) issued a
  namespaced custom-object call with an empty namespace against the
  cluster-scoped `Installation` CR — a malformed request that returned 403 on
  every tick, so Calico's control-plane components were never pinned to server
  nodes. Now uses the cluster-scoped get/patch, backed by a new
  `operator.tigera.io/installations` rule on the platform-api ClusterRole.
- **cosign trust anchor is now installed on every bootstrap.** It was written to
  `/etc/platform/cosign.pub` only inside the binary-install path, past the
  "already at `<version>`" early-return. Operators place the signed binary at
  `/usr/local/bin/insula` and *then* run `insula bootstrap`, so that check
  short-circuited and the anchor was never persisted — leaving self-upgrade dead
  (`doctor: cosign trust anchor MISSING`). The anchor is now persisted before the
  version check.

### Changed
- **Install docs recommend verifying the signed binary before running it** — fetch
  the project trust anchor (`platform/cosign.pub`) + the release `.sig` and
  `cosign verify-blob` the download before `chmod`/`mv`/run.

## [2026.7.5] - 2026-07-26

### Fixed
- **Fresh single-binary production install** (found in the first production
  cutover test). `insula bootstrap` deleted its own extracted installer tree
  the instant `bootstrap.sh` was spawned — a missing `await` in the SEA
  extraction — so every fresh install died at `cd .../scripts: No such file or
  directory`. Additionally, `install_sealed_secrets` now uses `helm repo add
  --force-update`, so re-bootstrapping a host that had a pre-migration install
  no longer retains a dead Sealed-Secrets chart-repo URL (404).
- **oauth2-proxy no longer deployed in production.** It depends on Dex OIDC —
  which runs only in dev/staging (production uses external IAM + the cookie
  gate) — but was shipped from the base into every overlay, so production's
  oauth2-proxy pod wedged in `Init:0/1` forever on a `wait-for-dex-discovery`
  that can never resolve. It now ships only with the Dex overlays (development,
  dind, staging); production renders zero oauth2-proxy and zero Dex.
- **system-pod-placement RBAC.** Granted the `platform-api` ServiceAccount
  `get/list/watch/patch` on `installations.operator.tigera.io` so it can pin
  Calico's control-plane components (Installation CR) — silences a `403 cannot
  list installations` logged every reconcile tick.

## [2026.7.4] - 2026-07-26

### Added
- **Single-binary install (`insula bootstrap`) + product-branded operator CLI**
  (ADR-055). The installer now ships *inside* the signed `insula` binary — the
  full `bootstrap.sh` + libraries + the k8s manifest tree travel as embedded
  assets (the mechanism host-migrations already use), so a fresh install is
  `curl` the binary + `insula bootstrap`, with no repo clone. The operator CLI
  is renamed `platform-ops` → **`insula`** (the internal module keeps its name);
  releases publish both `insula-linux-<arch>` and (for one transition) the legacy
  `platform-ops-linux-<arch>` so existing nodes' self-upgrade is never stranded.
  Host state consolidates under branded `/var/lib/insula` + `/etc/insula` roots,
  with the historical generic paths kept as compatibility symlinks (no data is
  moved and no host-migration re-runs — the code path constants are unchanged).
  Existing clusters converge via host-migration `2026.7.4/0001-rebrand-to-insula`.

## [2026.7.3] - 2026-07-25

### Added
- **Durable container-OOM detection.** The node-health reconciler now records
  containers OOM-killed at their memory limit (from container status, which is
  reliable even where cadvisor's kmsg OOM parser is broken and where a
  short-lived kill's metric series is torn down before the next scrape). These
  appear in the **Memory events** card and dispatch the same admin
  notifications as evictions — critical for system workloads, warning for
  tenant ones.

### Fixed
- **Worker nodes missed the kubelet memory-protection drop-in.** Host-migration
  `2026.7.2/0001` skipped any node without `/etc/rancher/k3s`, which k3s AGENT
  installs never create (workers only have `/etc/rancher/node`), so worker
  nodes got neither the eviction headroom nor the swap-off. Follow-up migration
  `2026.7.3/0001` re-applies with a unit-existence guard; it's a no-op on
  already-converged nodes. Caught by the `node-memory-protection` integration
  suite (worker allocatable gap 0 vs the servers' 1280Mi).

### Changed
- **Dependency currency + CI hardening.** The weekly npm/Go dependency groups
  are current (`@fastify/static` 10.1.2 override for the route-guard advisories,
  `golang.org/x/net`/`x/text` bumps, k8s client patches, GitHub Actions v7); the
  documentation manual-impact CI guard is now **enforcing** (a change to a
  user-visible surface must update the manual or carry a `Manual-Impact: none`
  trailer); and the build-deploy change-detection checkout fetches full history
  to stop an intermittent shallow-clone failure.

## [2026.7.2] - 2026-07-25

### Added
- **Node memory protection + OOM/eviction observability** (operator decision
  2026-07-25). Nodes run swap-less (bootstrap + host-migration `2026.7.2/0001`
  enforce it; `cluster doctor` flags drift) with kubelet
  `eviction-hard=memory.available<256Mi` + `system-reserved=1Gi` via a k3s
  config drop-in shared by servers and agents. Eviction order is now
  tenant-first by construction: platform Deployments/StatefulSets/CronJobs +
  CNPG system-db carry the new `platform-critical` PriorityClass (host-agent
  DaemonSets keep `system-node-critical`), while tenant pods stay at
  priority 0. Kernel SystemOOM and kubelet-eviction events are recorded by
  the node-health reconciler (`node_memory_events`, 30-day window), listed on
  Monitoring → Node health, and dispatched as categorized admin notifications
  — critical when a SYSTEM workload is hit (abnormal by design), warning for
  tenant evictions (the intended backpressure).
- **Integration suite `node-memory-protection`** (wired into `integration-all`,
  PARALLEL): host layer, eviction ordering, the SystemOOM event pipeline
  (exactly-once + notification), and the OOM metric path via a contained
  64Mi-limited hog with a kernel-truth cgroup assert. Feature-gated: SKIPs
  on clusters running a release older than v2026.7.2.

## [2026.7.1] - 2026-07-24

### Added
- **Resource monitoring: node-CPU alerts + per-tenant CPU/memory/storage
  saturation alerts.** New `node-cpu`/`node-cpu-critical` SLO rules read the
  already-scraped `container_cpu_usage_seconds_total{id="/"}` (previously
  unused) — zero new scrape cost. A backend evaluator, running off the metrics
  the hourly metrics-scheduler already collects, alerts admins
  (`admin.tenant_resource_saturation_warning/critical`) when a tenant crosses
  ~90%/100% of its CPU/mem/storage allocation — no per-tenant time-series
  (low-footprint by design).
- **Monthly per-tenant bandwidth cap.** Bandwidth is now a subscription-plan
  setting (`hosting_plans.bandwidth_gb_limit`, default 100 GB/mo) with a
  per-tenant override, editable in the admin plan editor + tenant Resource
  Limits card. An hourly meter accumulates month-to-date served bandwidth
  (Traefik-scraped cadvisor transmit bytes via vmsingle `increase()`), resetting
  on the 1st. At 80/90/100% it alerts BOTH admin and tenant, and at 100% it caps
  serving via a reconcile-durable redirect to a "Bandwidth limit reached"
  maintenance page (`platform-bandwidth-exceeded`), lifted automatically at the
  month rollover. Covered by `integration-bandwidth-e2e.sh`.
- **Cross-cluster migration now supports CIFS/SMB sources (all target types
  covered).** Migration/DR read a *foreign* backup target directly (bypassing the
  local backup-rclone-shim, which only routes THIS cluster's class bindings). The
  native direct-read covered S3 + SSH but had no SMB client, so a CIFS source was
  unusable as a migration source. New `RcloneBackupStore` reads a CIFS (and any
  future) source via the `rclone` CLI — the same rclone the shim runs, but one-shot
  against a single target rendered by the shim's own `renderUpstreamSection`
  (obscured-password + SMB semantics identical to the write path), with config
  passed via `RCLONE_CONFIG_*` env (never written to disk) and *no* changes to the
  shared shim (no DaemonSet roll, no taxonomy/CI-guard churn). `rclone` is added to
  the backend image (like `restic`). Direct-read migration coverage is now **S3
  (access+secret key), SSH (key or password), and CIFS/SMB** — matching what backup
  + restore already do through the shim.

### Fixed
- **CloudNative-PG operator bumped to latest stable `v1.30.0` (chart `0.28.3 →
  0.29.0`).** Version hygiene + a partial mitigation of a barman-cloud
  WAL-archiver plugin-roll bug: when the postgres-objectstore reconciler ADDS the
  barman-cloud plugin to a running `system-db` cluster (on a SYSTEM backup-target
  bind), CNPG must roll the primary to inject the archiver sidecar, and that roll
  can loop forever (`Primary instance is being restarted without a switchover` /
  `PodSpec differ … has been added`). 1.30.0 fixes this for the **HA / multi-instance
  `primaryUpdateMethod: switchover`** path — it now recreates the primary Pod in
  place so the sidecar is injected (cnpg#11032/#11059). **It does NOT resolve the
  platform's single-instance (`instances: 1`) case** — any roll of a running
  single-instance primary (plugin add, and even a probe/config change) still
  wedges on both 1.29.1 and 1.30.0. That is a distinct CNPG limitation, reported
  upstream and tracked separately (fix candidates: pin the primary to its PVC node
  so the RWO re-attach stays local, or run system-db HA). plugin-barman-cloud
  `v0.13.0` (already latest) is unchanged. The pin reaches existing clusters via
  host-migration `2026.7.1/0003` (`helm upgrade --reuse-values`; the chart
  templates its CRDs, so they roll too).
- **DR-recover / migration-import of a DELETED tenant is idempotent again.** Since
  deleted tenants now RETAIN their bundle catalog (loose FK — the `backup_jobs`
  row survives so the bundle stays recoverable), re-importing/recovering that
  tenant on the SAME cluster aborted with `backup_jobs_pkey` (and duplicated
  `backup_components` rows) — the recover re-registered a bundle index that
  assumed the source row had been cascade-dropped. `dr-recover` now clears any
  existing catalog rows for the bundle before re-registering, so both
  cross-cluster import (nothing to clear) and same-cluster recover work.
- **Cross-cluster migration now reads password-authenticated SSH sources.** The
  migration source direct-read (`resolveDirectStoreForBundle` → `SshBackupStore`,
  used by `POST /admin/migration/list-tenants` + import and by DR direct reads)
  only accepted SSH targets with an inline private KEY, and rejected
  password-authenticated SSH targets (e.g. Hetzner storageboxes, which the
  backup-rclone-shim write path and backup-target test-connection already
  support) with `SSH backup target missing required fields`. It now honours
  `ssh_password_encrypted` as well as `ssh_key_encrypted` (the DB already
  requires at least one), so a migration source using SSH password auth is
  read directly with no rebind.
- **Bundle verifier now actually probes files reachability.** The
  `POST /admin/tenant-bundles/:id/verify` (and `verify-all`) endpoints reported
  the `files` component by statting a `files/archive.tar.gz` object under the
  bundle handle — but since the raw-files floor became a **restic snapshot** in a
  per-(tenant,component) repo, that object never exists, so verify always said
  "files: not reachable" (and verify-all would fail every files-bearing bundle).
  Both now resolve the recorded files snapshot id
  (`backup_components.sha256`) and list the per-tenant restic repo's snapshots
  through the same shim target the browse path uses (metadata-only, no tree
  walk), reporting reachable=true only when that snapshot is present.
  `listResticSnapshots` gained an explicit `repoUri` arg so a caller can target
  a specific tenant/component repo (a SHIM target otherwise resolves only to the
  class-root repo). mailboxes (also restic) is no longer false-failed by the
  batch verifier's store-artifact probe.
- **Staging now follows RC host-migrations.** `platform-ops self-upgrade` picks
  its target from the `platform-version` ConfigMap, but the base ships
  `version: "unknown"` and only the development overlay patched it — so
  production and staging both ran with `"unknown"`. That failed `isValidVersion`,
  and the fallback is GitHub `/releases/latest`, an endpoint that **excludes
  prereleases**. Staging therefore targeted the newest STABLE while Flux had an
  RC applied, so an RC's host-migrations were **never exercised on the cluster
  whose entire job is validating RCs** (observed 2026-07-15: staging ran
  platform-ops rc.20 / 2026.6.18 with rc.21 deployed). `cut-release.sh` now
  stamps the release version into a production-overlay `platform-version` patch,
  which staging inherits — so each cluster's platform-ops targets the version it
  is actually running, no update-channel concept needed. Production benefits
  too: its platform-ops now matches the admin-pinned release instead of jumping
  to the newest stable, which is what the admin-controlled pull model intends.
  Side effect: the admin panel no longer reports the platform version as
  "unknown" on staging/production.

### Changed
- **Admin node-terminal is now enabled in PRODUCTION by default** (operator
  decision 2026-07-24). The old "off until an HA-stickiness path exists" caveat
  was obsolete: the `wsToken` is validated against the Postgres
  `node_terminal_sessions` table, so any platform-api replica can serve any
  session. `bootstrap.sh`, the production overlay, and the runbook now agree;
  the in-code default stays off (opt-in flag invariant).
- **Dependency currency sweep ahead of the first stable production release**
  (resolves all 16 open Dependabot PRs). npm: the 31-package minor/patch group
  plus majors @fastify/rate-limit 11, nodemailer 9 (closes the
  GHSA-p6gq-j5cr-w38f ledger entry for real), js-yaml 5 (default imports
  migrated to named imports — v5's CJS build has no default export — and
  @types/js-yaml dropped since v5 bundles types), @fastify/swagger-ui 6,
  @types/node 26. TypeScript 7 is deferred until typescript-eslint supports it
  (`.github/dependabot.yml` ignore rule documents why). Go images: k8s.io
  client bumps + `go 1.26.5` directives across all five first-party images,
  clearing the 100 osv stdlib advisories on component-watch #99 (the two
  remaining x/crypto-openpgp findings are ledger-waived — the openpgp
  subpackage is never imported and upstream ships no fixed release). GitHub
  Actions: setup-node 7, codeql 4, docker login 4 / build-push 7,
  upload-pages-artifact 5. `images/file-manager` added to the Dependabot gomod
  watch — it was the one Go image missing from it.

### BREAKING
- **k3s upgraded `v1.35.5+k3s1 → v1.36.2+k3s1` (Kubernetes 1.36).** Existing
  clusters roll through `platform-ops cluster upgrade` (system-upgrade-controller
  Plans, one sequential minor — the Plan generator refuses skip-a-minor/downgrade).
  The upgrade pre-flight surfaces this entry and **requires acknowledgment before
  draining any node**. Kubernetes 1.36 removes long-deprecated beta APIs; the
  platform's manifests use current stable apiVersions (nothing in `k8s/` references
  a removed API), and k3s runs with `--disable=traefik` so the bundled-Traefik
  chart change in the k3s release notes does not apply. Node drains are sequential
  (cordon → drain → upgrade → uncordon); a single-node cluster sees a brief
  control-plane pause (see the k3s minor-upgrade downtime target).
- **Tenant SFTP is reachable for the first time — new host, new port, FTPS
  removed.** Tenant file upload never worked on any real deployment: the
  gateway Service was `type: LoadBalancer`, but bootstrap runs k3s with
  `--disable=servicelb` and self-managed VPS nodes have no cloud LB, so it sat
  at `EXTERNAL-IP <pending>` forever and **nothing ever bound the port**. It is
  now a **hostPort DaemonSet on every control-plane server**, mirroring the
  `stalwart-haproxy` mail DaemonSet — the platform's pattern for raw TCP.
  - **Connect to `files.<apex>:23022`** (was: an unreachable `sftp.<apex>:2222`
    — and before that the connection-info API literally advertised the local
    dev hostname `sftp.k8s-platform.test`, because the `sftp_gateway_host`
    setting it read was never written by anything). The port stays overridable
    via `sftp_gateway_port`. 23022 is constrained: a hostPort must stay outside
    30000-32767 (NodePort range) and below 32768 (the ephemeral range, where it
    can collide with outbound source ports).
  - **Operators must add DNS:** `files.<apex>` CNAME → `<apex>`, whose A records
    already point at the control-plane servers, so it round-robins across
    exactly the nodes running the DaemonSet. `files.<apex>` is now a reserved
    platform hostname (ADR-040) and can no longer be claimed by a tenant.
  - **Firewall:** fresh installs get the `23022/tcp` accept from `bootstrap.sh`;
    existing clusters are backfilled by host-migration
    `2026.7.1/0002-sftp-gateway-firewall-port.sh` (ADR-045 W10c).
    `firewall-reconciler` cannot do this — it only opens hostPorts for tenant
    namespaces (`client-*`), not `platform-system`.
  - **FTPS is REMOVED** (`ftps_port` and the `ftps` instruction are gone from
    the connection-info API). It never actually ran — its TLS Secret is
    `optional: true` and nothing ever created it, so the listener self-disabled
    on every deployment while the API still advertised FTPS to tenants. It also
    cannot be exposed sanely: passive mode needs a 100-port range (whose old
    `30000-30099` default collided with the NodePort range) plus a per-node
    public IP a DaemonSet cannot supply, and active mode is unusable behind NAT
    — doubly so with TLS hiding `PORT` from `nf_conntrack_ftp`. SFTP/SCP/rsync
    over the same gateway cover the use case with stronger auth.

### Added
- **Deleted-tenant backup retention is now an admin setting.** Deleting a tenant
  RETAINS its off-site backup bundles (they are the deleted tenant's only DR /
  cross-cluster-migration recovery path) instead of purging them — the
  `retention.ts` reaper deletes them once their grace window passes. That window
  is now operator-configurable at **Platform → Limits → Deleted-Tenant Backup
  Retention** (`system_settings.deleted_tenant_bundle_retention_days`, migration
  0071; default 30 days, 1–3650). On delete the `tenant-bundles-cleanup`
  lifecycle hook *floors* every reap-eligible bundle's `expires_at` to
  `now + N days` (extend-never-shorten: a retain-forever bundle finally gets an
  expiry; a bundle already scheduled to live longer keeps its later date, so a
  recovery copy is never destroyed earlier than already planned). Pairs with the
  migration-0070 loose FK that lets the bundle rows survive the tenant row.
- **Tenant add-on databases: two-layer backup + visible dump summary**
  (ADR-048 Primitive 3 evolution). Every add-on database (MariaDB/MySQL,
  PostgreSQL, MongoDB, SQLite) is now captured two ways in a bundle: the
  **raw-files floor** (the `files` restic snapshot always includes each
  engine's on-disk datadir, which crash-recovers to committed-consistent —
  so a bundle is never without a recoverable copy) **plus** a best-effort
  **logical dump** on top for portable / cross-version restore. SQL dumps run
  `mysqldump`/`mariadb-dump --single-transaction --quick --routines
  --triggers` (**hot-consistent, no table lock, no write-downtime**);
  **MongoDB is now covered** via `mongodump --archive --gzip` (was silently
  unsupported). A **free-space guard** skips the logical dump when the DB
  pod's volume is >= 90% full or < 200 MiB free, so a dump can never `ENOSPC`
  the live database. Per-database outcome is recorded in a new
  `backup_jobs.database_dumps` JSONB column (contract type
  `BackupDatabaseDumps`), surfaced on `GET /admin/tenant-bundles/:id`, with
  per-db status `dumped`/`degraded`/`failed` and bundle roll-up
  `ok`/`degraded`/`none` + `remediation`. This dump summary is a **separate
  dimension** from the bundle's `status`: a `completed` bundle can carry a
  `degraded` `database_dumps` and stays fully restorable via the raw-files
  floor — a degraded/failed logical dump never flips the bundle to `partial`
  and never blocks restore. Restore re-imports the logical dumps via the
  `databases-by-id` restore item (SQL through `importSqlFromPvcFile`, MongoDB
  `.archive.gz` through `mongorestore --archive --gzip --drop`), skipping
  gracefully when a DB pod is down or no dump exists; raw datadir restore
  stays available via `files-paths`. New operator runbook:
  `docs/operations/DATABASE_RECOVERY.md`.
- **`platform-secrets` mirror drift-guard** — `platform-secrets` lives in the
  `platform` namespace but the sftp-gateway runs in `platform-system` and mounts
  a mirrored copy (k8s has no cross-namespace secret refs). Bootstrap mirrored it
  **once** (skip-if-exists), so rotating the `platform` source left the
  `platform-system` copy stale — the gateway's `internal-secret` then no longer
  matched platform-api's `PLATFORM_INTERNAL_SECRET` and **every SFTP auth 403'd,
  silently, for all tenants** (found on DEV 2026-07-02, drifted since the
  06-22 rebuild; nothing had exercised SFTP). Now drift-proofed three ways:
  platform-api re-asserts the mirror on boot (`reconcilePlatformSecretsMirror`,
  mirrors the mail-master auto-heal shape), the sftp-gateway Deployment carries a
  `secret.reloader.stakater.com/reload: platform-secrets` annotation so a heal
  auto-restarts it, and `bootstrap.sh` now reconciles the mirror every run
  instead of skipping when present.
- **Webmail master-credential drift detection + self-heal** (`mail-drift`) — the
  principals-sync detector now VERIFIES the Stalwart master (`master@<sentinel>`)
  can authenticate, not just that it exists. A master that is present but whose
  password has drifted out of sync with `mail-secrets` (e.g. a Stalwart
  redeploy/restore that reset the account — the 2026-07-01 staging incident) is
  flagged AND **auto-healed**: the detector re-asserts the `mail-secrets`
  password onto Stalwart (no new password, no webmail roll) so a reset can never
  leave impersonation persistently broken. Kill-switch `MAIL_MASTER_AUTOHEAL=disable`.
  New `verifyMasterJmapAuth`, `readStalwartMasterPassword`,
  `reconcileStalwartMasterCredential`; `rotate-jmap` gains `explicitPassword`.

### Fixed
- **Mail failback no longer hangs when the target node is still recovering**
  (`mail-dr`, failback reliability) — a failback consistently timed out at
  `scaling-up` ("pod did not become Ready within 600s"). Root cause (pinned on live
  destructive runs 2026-07-04, via the new diagnostics below): a failback fires
  while the target node is still coming back from the k3s restart it took during the
  preceding failover — it reports **NotReady with `node.kubernetes.io/{not-ready,
  unreachable}` taints**, which blocks BOTH local-path provisioning (`pvc=Pending
  vol=<unbound>`) AND pod scheduling (untolerated taint), so the whole migration
  burns the full 600s timeout. Two composed fixes:
  1. **Target-node-readiness gate** — preflight now waits (before any destructive
     swap) for the target node to be `Ready` with its recovery taints cleared, so a
     migration never tears down the source for a node that isn't schedulable yet;
     a target that never recovers fails the migration cleanly. No-op for an
     already-Ready target.
  2. **Stale-provisioner bounce** — once the node is Ready, the single-replica
     local-path provisioner can still be stale toward it (`create process timeout
     after 120s` / `failed to save logs: … resource name may not be empty`), so the
     fresh PVC never binds. After scale-up the migration polls the target PVC and,
     if it stays unbound past a grace window, bounces the provisioner pod (its
     ReplicaSet recreates it — the Flux-safe restart pattern; proven to bind the PVC
     within seconds) up to a bounded number of times.

  A scaling-up timeout also now captures the pod's Pending/Unschedulable reason,
  init/container waiting reasons, the PVC bind state, and recent Warning events into
  the run error — previously the only signal was the opaque "did not reach 1 ready
  replica" (this diagnostic is what pinned the root cause). A defensive sweep of any
  Released/Available `mail-stack-data` orphan pinned to the target node (data-safe,
  target-scoped, never the retained source or a Bound PV) also runs before recreating
  the PVC.
- **Mail snapshots can no longer poison `latest` with an empty (0-byte) capture**
  (`mail-dr`, snapshot integrity) — a restic snapshot fired during a DR PVC-swap
  window (or after a failed failback left mail down) captured an empty DataStore;
  `latest` then pointed at it and the `restore-state` init FATAL'd "Snapshot is
  malformed" and crash-looped. Two-sided fix: (1) `snapshot-upload.sh` refuses to
  back up unless the RocksDB `CURRENT` sentinel is present, so an empty/mid-swap
  store is never snapshotted; (2) the `restore-state` init walks candidate
  snapshots newest→oldest and skips any empty/malformed one, falling back to the
  newest snapshot that actually holds a DataStore (a pinned per-snapshot restore is
  still honored exactly, never silently substituted).
- **Webmail impersonation heals AT cutover after a failover** (`mail-dr`) — a
  restore brings Stalwart up with the SNAPSHOT's master-account password,
  drifted from `mail-secrets`, so Bulwark/Roundcube impersonation was broken for
  all mailboxes until the slow principals-sync auto-heal tick caught it
  (post-failover master-auth could stay broken for minutes). The migration
  cutover now re-asserts the `mail-secrets` master password onto Stalwart
  immediately (Step 8b1b, mirroring the admin re-sync), so impersonation heals
  at cutover regardless of the flag-gated security-hygiene master rotation.
- **Mail failover no longer loses snapshot-captured mail to a stale standby
  copy** (`mail-dr`, restore freshness) — the failover restore's FAST PATH
  copied the standby-rsync pre-staged data and skipped restic whenever the
  standby marker was younger than `STANDBY_MAX_AGE_SECONDS` (30 min). But a
  recent marker only means the last rsync *finished* recently, not that its
  data contains the latest deliveries — a message delivered after the last
  rsync yet captured in a snapshot was absent from the standby copy, so a
  failover could restore data up to 30 min stale and drop mail that a *fresher*
  snapshot held. The restore-state init now compares the standby marker against
  the latest restic snapshot's time and rejects the FAST PATH (restoring the
  snapshot via restic) whenever the snapshot is newer — so snapshot-captured
  mail always survives a failover.
- **Mail failover now verifies the TLS cert is actually *served*, not just
  issued** (`mail-dr`, issuance≠serving) — after a failover/DR cutover the
  reconcile fires the ACME order, but Stalwart binds a freshly-issued cert to
  its `:465` listener on its own reload cadence (observed ~1h lag), so a
  failover could complete while the node still served the bootstrap self-signed
  `rcgen` cert — and mail was reported "healthy" over it. The cutover now polls
  the served cert (`waitForServedMailCert`); if still self-signed after the
  issuance grace it recycles Stalwart once to reload the stored cert, and a
  persistent failure fires a loud operator alert (`notifyAdminsMailCertNotServing`)
  instead of a silent "healthy". The mail DR + external-reachability integration
  suites now poll the served cert (forcing a reconcile) and treat a persistent
  self-signed listener as a hard FAIL.
- **`local.host` master sentinel no longer flagged as an orphan-domain** — the
  drift detector excluded the mail-hostname anchor but not the sentinel Domain
  that holds the master; a `delete-orphan` on it would have destroyed the master
  and broken ALL impersonation.
- **Stalwart Domain teardown hardened** — `destroyStalwartArtifactsForEmailDomain`
  now retries the Domain destroy (3×, backoff) to ride out a transient Stalwart
  redeploy window and reports its outcome, cutting the orphan-domain pile-up left
  by best-effort tenant-delete cleanup.

### Security
- **cert-manager upgraded `v1.20.2 → v1.20.3`** (component-watch tier-0) — fixes
  **GHSA-8rvj-mm4h-c258** (HIGH): the default `cert-manager-edit` ClusterRole let
  namespace users create ACME `Challenge`/`Order` resources directly, enabling a
  crafted Challenge to supply attacker-controlled solver config (with acme-dns,
  disclosing DNS creds). Low reachability in our model (tenants have no kube-API
  access — all mutations go through platform-api), but a tier-0 HIGH with "all
  users should upgrade", so patched promptly. Tracked in `security/cve-ledger.yaml`.
- **undici upgraded to 6.27.0** (`npm audit fix`, within range) — clears the four
  backend HIGH advisories (Set-Cookie header injection, WS DoS, response-queue
  poisoning, SameSite downgrade) on the transitive `<=6.26.0` copy. The other
  undici moved 7.27.2→7.28.0. Backend unit suite green (5473). nodemailer's
  GHSA-p6gq-j5cr-w38f stays tracked as `not_affected` (the `raw` message option is
  unused; the fix is a breaking 8→9 major) — the temporary undici cve-ledger
  waivers are removed now that it's fixed in-tree.
- **Mail-stack images bumped** (component-watch tier-0): Stalwart `v0.16.9 → v0.16.11`
  (drop-in patch — encryption-at-rest, IDN/OAuth/IMAP-objectid features + DANE/TLS/JMAP
  fixes; no config/cert/port change), Bulwark webmail `1.6.7 → 1.7.6`, and Roundcube
  `1.6.16 → 1.7.1` (both digest-pinned). Validated against the staging cluster (Stalwart
  SMTP/IMAP/JMAP + webmail).

### Changed
- **Component-watch upstream-drift sweep (ADR-050).** Bumped six swept components
  to current upstream: **Stalwart `v0.16.11 → v0.16.12`** (DKIM2/DMARCbis +
  DANE/OIDC fixes), **VictoriaMetrics `v1.145.0 → v1.147.0`** (base Alpine
  3.23.4→3.24.1 security bump), **CNPG barman-plugin `v0.12.0 → v0.13.0`** (lz4
  base-backups, WAL-restore error classification; ObjectStore CRD schema
  unchanged), **Traefik chart `41.0.0 → 41.0.2`** (app v3.7.5→v3.7.6), and **CNPG
  chart `0.28.2 → 0.28.3`** (operator patch). The three Flux-managed images
  reconcile onto existing clusters automatically; the three `bootstrap.sh` chart
  pins reach existing clusters via host-migration `2026.7.1/0001`, which upgrades
  each release in place with `helm upgrade --reuse-values --version` (reuse-values
  is mandatory — a bare `--set` upgrade would reset Traefik's DaemonSet/hostPort/
  plugin/trustedIP values and tear down the ingress perimeter). Registry pins +
  `updated:` stamp refreshed. DEV-validated (all six live, system-db WAL archiving
  healthy through the barman + cnpg-operator rolls, ingress serves HTTP 200 through
  the rolled Traefik, migration idempotent on re-run). rclone `1.74.1 → 1.74.4`
  deliberately deferred (spans three coupled sites the code requires kept aligned).
- **Component-watch upstream-drift sweep — round 2 (ADR-050).** Continuation of the
  sweep above (registry pins synced so the drift/coverage guard stays honest).
  Flux-managed image bumps (reconcile onto existing clusters automatically,
  DEV-validated live): **Stalwart `v0.16.12 → v0.16.14`**, **VictoriaMetrics
  `v1.147.0 → v1.148.0`**, **ModSecurity-CRS `4.25.0 → 4.28.0`**, **Bulwark webmail
  `1.7.6 → 1.7.7`**, **Roundcube `1.7.1 → 1.7.2`** (fpm-alpine, digest-pinned),
  **nginx (platform-suspended) `1.30 → 1.31-alpine`**, **frp `v0.69.1 → v0.70.0`**,
  **curl `8.20.0 → 8.21.0`**, and **rclone image `1.74.1 → 1.74.4`** — closing out
  the deferred rclone bump. Host binaries (fresh-install pins, not in the
  migration-coverage guarded set): **age `v1.2.1 → v1.3.1`** and the **rclone
  binary `v1.74.1 → v1.74.4`** (kept in lockstep with the rclone image). And a
  guarded chart bump: **cert-manager `v1.20.3 → v1.21.0`** (ACME Renewal
  Information + security hardening) — reaches existing clusters via host-migration
  `2026.7.1/0004` (`helm upgrade --reuse-values`). The v1.21 chart drops the
  default `tokenrequest` RBAC, which is a no-op here (our ClusterIssuers are ACME
  http01/dns01 only — no `serviceAccountRef`).
- **Component-watch drift sweep — infra tranche (ADR-050).** The guarded
  bootstrap-pinned infra components, each reaching existing clusters via a
  host-migration under `platform/host-migrations/2026.7.1/` (verified on staging
  via RC before promotion): **sealed-secrets chart `2.18.6 → 2.19.1`** (controller
  `v0.37.0 → v0.38.4`; `0005`, `helm upgrade --reuse-values`), **Calico
  `v3.31.6 → v3.32.1`** (`0006`, re-applies the tigera-operator manifest; operator
  rolls calico-node), **Longhorn `v1.11.1 → v1.12.0`** (`0007`, `helm upgrade
  --reuse-values`; v1.12 removes V2/SPDK backing images — a no-op here, this
  platform runs the default V1 engine only), and **Flux `2.8.8 → 2.9.2`** (`0008`,
  pins the CLI + `flux install`; Flux 2.9 drops EOL beta CRD apiVersions — a no-op
  here, all our objects use `*.toolkit.fluxcd.io/v1`; min-k8s `>= 1.35.0` is met by
  our current k3s so there is no ordering dependency on the k3s bump). **k3s
  `v1.35.5+k3s1 → v1.36.2+k3s1`** ships as a pin only — existing clusters upgrade
  through `platform-ops cluster upgrade` (system-upgrade-controller Plans, one
  minor step), not a host-migration; see BREAKING below.
- **Integration-test sprawl cleanup + coverage guard.** An audit found 33 of 71
  `scripts/integration-*.sh` wired into no orchestrator — ~half the E2E suite never
  ran and **8 scripts had bit-rotted** (testing removed routes: `mail/node-selector`,
  `mail/blob-store`, `/system-backup/runs`, `/catalog/entries?code=`, `companyEmail`,
  `tenants/bulk/delete`, the `thisNodeOnly` port-exposure enum). Added
  `scripts/integration-test-registry.txt` (every script categorized:
  suite/perf/local/manual/pending) + `ci-integration-coverage.sh` (a new
  `integration-*.sh` not in the registry fails Infrastructure CI — sprawl can't
  regrow) + a self-test. Deleted 3 dead scripts (`mail-ha-e2e` 7/13-dead,
  `backups-ui-phase-2026-05-24` dated, `tenant-bundles-jmap` subset-of-full-e2e);
  fixed two route/field bit-rots (`dr-bundle`, `tenant-bundles-restic`). The 21
  `pending` feature-E2E (each route-validated against the live backend) are tracked
  in the registry for staging-validated integration.
- **Tenant hard-delete returns promptly** (~68 s → single digits for a
  provisioned tenant). `DELETE /tenants/:id` blocked the request on two
  synchronous waits for the namespace's Longhorn PV to Release — neither of which
  *can* complete inside the request, because the namespace delete that releases
  the PV runs between them: (1) the `pv-cleanup-released` lifecycle hook polled up
  to 60 s for a PV that is still Bound at hook time (it runs before the namespace
  delete), and (2) the post-namespace-delete volume reap waited up to 45 s for the
  PV to Release. The hook now early-exits (~6 s) once it sees the PV can't release
  yet, the reap runs detached in the background, and the tenant row is dropped
  synchronously so the tenant disappears from the API immediately. Both cleanups
  still happen — via the reap + the 2-min lifecycle-hook scheduler retry +
  Orphaned-Volumes safety nets — just off the request path. This also stops
  concurrent deletes from piling up slow requests on the API.
- **external-snapshotter upgraded v6.3.0 → v8.6.0** (latest stable). The
  running snapshot-controller on staging was actually v6.2.1 — even older
  than the previous pin claimed. v8 requires k8s ≥ 1.25 (CRD CEL validation
  rules); clusters run 1.35. This is a pin bump in `scripts/bootstrap.sh`
  plus a re-apply of the upstream CRDs + RBAC + snapshot-controller
  Deployment, and it realigns the controller with the v8.x CRD set already
  referenced by `k8s/base/longhorn/csi-snapshots.yaml`. Safe by inspection:
  the VolumeSnapshot storage version has been v1 since external-snapshotter
  v4.1, no v1beta1 objects exist (CRDs already serve v1 only), so the CRD
  update is additive; VolumeGroupSnapshot CRDs are intentionally omitted
  (the controller is Ready on the v1 CRD set alone). Underpins the CNPG
  snapshot-PITR path and the Longhorn `VolumeSnapshotClass`.
- **Bootstrap-pinned infra now upgrades existing clusters via a host-migration**
  (the path I previously hand-applied). A `bootstrap.sh` infra-version-pin bump
  reaches FRESH installs only — Flux/RC applies app overlays, never `bootstrap.sh`.
  So the external-snapshotter bump ships
  `platform/host-migrations/2026.6.19/0001-external-snapshotter-v8.sh` (ADR-045
  W10c): embedded in the signed `platform-ops` binary, run host-side by the
  `platform-ops host-config` converger in `enforce` (idempotent; exits 0 once the
  v8 selector is present; workers no-op via least-priv RBAC). New forcing function:
  `ci-migration-coverage.sh` now fingerprints the bootstrap **infra version pins**
  (k3s/Calico/Longhorn/Traefik/cert-manager/sealed-secrets/CNPG/Flux/snapshotter)
  alongside the firewall shape — any pin bump without a matching host-migration
  fails the build.
- **`platform-ops self-upgrade` now converges host-migrations immediately**
  (apply-on-Apply). After a successful binary self-upgrade it re-execs the
  just-replaced binary as `host-config apply`, so the new release's
  host-migrations apply on the same cycle instead of waiting for the next daily
  `platform-ops-host-config.timer`. Best-effort (the timer remains the backstop,
  so a converge failure never fails the upgrade) and SEA-only; no `--apply`, so
  each host-config surface still honours its own enforce/observe policy.

### Fixed
- **Mail migration to a worker node no longer deadlocks — and never loses mail data.**
  Migrating the active mail node could hang at `swapping-pvc` ("failed to delete
  source PVC after 120 s — finalizer stuck") when a pod on a *healthy* node held the
  source PVC's `pvc-protection` finalizer open — a Running/Completed snapshot pod or
  a Pending Stalwart pod. The previous escalation only force-deleted pods on *dead*
  nodes, so it missed these, and the rollback then scaled Stalwart back up onto the
  still-Terminating PVC → permanent deadlock (pod Pending forever, PVC never deletes)
  → mail down on every node (observed migrating to the worker node, 2026-06-30).
  Now `deletePvcAndWait` force-deletes EVERY pod referencing the PVC (any node, any
  phase) and, as a data-safe last resort, strips the `pvc-protection` finalizer —
  safe because the swap flips the source PV to `Retain` first, so the on-disk store
  survives the PVC-object removal; and the rollback force-completes a stuck-Terminating
  PVC before re-binding the retained PV. The retained source PV preserves the mail
  store throughout, so no migration failure path can lose data.
- **Mail migration no longer fails when Stalwart's graceful shutdown is slow.**
  The node-swap migration scaled Stalwart to 0 and waited only 90 s for the
  Deployment to reach 0 ready replicas, but the pod's
  `terminationGracePeriodSeconds` is 300 s and its SIGTERM path drains live
  connections (incl. the haproxy backend health checks on the dedicated PROXY
  listeners), which can exceed 90 s — failing the migration at `scaling-down`
  ("did not reach 0 ready replica(s) within 90 s"). The scale-down now keeps the
  90 s graceful window, then **force-deletes (grace 0) the mail pod(s) still
  mounting the source PVC** to guarantee it releases for the swap. Data-safe: the
  pre-migration snapshot already captured the store and the source PV is retained
  (rollback-safe), and RocksDB recovers via its WAL after a SIGKILL. Operator
  cancel is still honoured.
- **Mail migration is now data-safe on local-path volumes.** The node-swap
  migration deleted the source `mail-stack-data` PVC (StorageClass `local-path`,
  `reclaimPolicy: Delete`) *before* the destination was confirmed populated, and
  had **no rollback** — so a stuck-finalizer delete (or any post-delete failure)
  wiped the only live copy of the mail store, surviving only because of an
  out-of-band restic snapshot (data-loss incident 2026-06-28). The swap now flips
  the source PV to `Retain` **before** the delete (data survives regardless), and
  every post-delete failure path (PVC-delete fail, target-PVC create fail, affinity
  fail, scale-up/cancel, restore-verify fail) rolls mail back onto the source's
  retained volume instead of leaving it on an empty disk; the retained PV is GC'd
  only after the destination is verified.
- **External mail to non-active nodes works (the real multi-node fix).** On a
  multi-node cluster, external mail to a NON-active node was accept-then-dropped.
  Root cause: the `stalwart-mail` Service carried `externalIPs` = the non-active
  node IPs, and kube-proxy's externalIP PREROUTING DNAT **preempted the haproxy
  hostNetwork socket entirely** — haproxy received zero external traffic and mail
  was DNAT'd straight to the Stalwart pod, so `send-proxy-v2` never ran and the
  real client IP was lost. Calico/WireGuard then masqueraded every cross-node
  client to the origin node's pod-network tunnel IP (10.42.x), so all external
  clients collapsed onto ONE tunnel IP hitting six mail ports → Stalwart's
  `portScanning` autoban permanently banned that tunnel IP and **mail died on the
  node**. The previous PROXY-v2 trust (node public IPs) targeted an address
  Stalwart never saw cross-node, so it never worked. Fix: platform-api now resolves
  the Service externalIPs to `[]` (haproxy receives external mail directly via its
  hostPorts); Stalwart gains six DEDICATED PROXY-protocol listeners
  (12025/12465/12587/12143/12993/14190) that trust the cluster **pod CIDR**; and the
  haproxy backends repoint to those listeners with `send-proxy-v2`. Stalwart now
  parses the PROXY header from the (masqueraded) pod-CIDR source and recovers the
  **real client IP**, so SPF/DKIM and the port-scan autoban operate on real IPs.
  The standard mail listeners stay PROXY-free for the active-node hostPort path and
  in-cluster direct clients (Roundcube, Bulwark, health probes). Newly-created
  proxy listeners are bound via a one-time Stalwart recycle on first creation.
  **Reverts** the prior `proxy-networks-reconciler` "track pod identity + recycle
  on trust write" self-heal (`v2026.6.18-rc.8`) — it was built on the disproven
  theory that haproxy fronted the mail ports and Stalwart saw node IPs.
- **Inbound mail (MX, port 25) now accepted on the haproxy/non-active nodes.** The
  dedicated `smtp-proxy` listener (port 12025) inherited Stalwart's default
  `MtaStageAuth.require` (`require auth when local_port != 25`), so it rejected
  unauthenticated inbound `MAIL FROM` with `503 must authenticate first` — breaking
  real external mail delivery on ~2/3 of nodes (round-robin). The domain reconciler
  now sets `MtaStageAuth.require.else` to `local_port != 25 && local_port != 12025`,
  so port 12025 is treated as a no-auth inbound MX like port 25 (submission/IMAP
  proxy listeners stay auth-required). Applied via the same one-time Stalwart recycle
  that binds the proxy listeners.
- **Snapshot archives no longer leak when a tenant is hard-deleted.** The
  snapshot-store purge ran *after* the delete cascade dropped the tenant row, but
  `storage_snapshots` cascade-deletes with the tenant — so the purge queried zero
  rows and the archives were orphaned in the store forever. The purge now runs
  *before* the row drop, while the snapshot records still exist.
- **Integration harness robustness.** `drain` no longer hard-fails on best-effort
  Longhorn replica-record GC lag (it warns instead; the real drain invariants —
  active replicas + workloads moved off the node — still fail hard); the `pvc`
  suite treats a 404-after-retry on a tenant DELETE as an idempotent success;
  and `integration-cleanup.sh` now matches every test-tenant name format (by the
  reserved `example.test` email domain + a trailing epoch) so stale test tenants
  can't accumulate and trip the leak guard.
- **Mail integration probes survive a Stalwart roll/migration.** The harness
  allowlists its public IP in Stalwart's `x:AllowedIp` so its rapid multi-port
  mail probes (25/465/587/993/4190) aren't accept-then-dropped by the port-scan
  autoban. A one-time guard meant the allowlist was never re-armed after a
  scenario rolled or migrated Stalwart (`mail_hostname_rename`,
  `mail_migration_fixes`) — and a node-swap onto a fresh RocksDB store drops the
  entry, so every later mail probe banned the harness IP (the recurring
  `staging-all` mail-flake tail). The allowlist helper now takes a `force`
  argument that re-registers + unbans + reloads after each roll (a cheap no-op
  when the entry survived); `mail_tls`, `mail_hostname_rename`, and
  `mail_migration_fixes` call it post-roll.
- **`mail_hostname_rename` is reproducibly green and stops burning LE certs.**
  The scenario hard-failed on two checks that race *external* Let's Encrypt
  issuance under load: a `defaultHostname` read via the `stalwart-mgmt` *service*
  (empty while the rollout's endpoint was unready) and a cert-SAN poll (LE took
  longer than the budget). Investigation showed the rename itself is fast
  (backend applies it + triggers ACME in ~21 s; Stalwart's `defaultHostname`
  updates in ~15 s; pod Ready ~40 s) — the only slow phase is LE issuance, which
  the platform doesn't own in-window. Fix, split by responsibility: the
  `defaultHostname` check now reads the pod **loopback** JMAP (up the instant the
  pod is Ready, ~15 s) and the SMTP-465 banner stays a **hard** gate — these prove
  the platform applied the rename; cert-SAN coverage is now **advisory**
  (`certfail`, promotable with `MAIL_RENAME_CERT_STRICT=1`) since it depends on
  external LE. Also, the test host is now a **stable** `mail-e2e-rename.<apex>`
  instead of a per-run timestamp: LE rate-limits per *registered domain*, so
  unique names burned a fresh cert every run (≈14 leftover anchor rows found on
  staging); a fixed name lets Stalwart cache and reuse the cert. Validated: two
  back-to-back runs 7/0 in ~56 s each (was ~9 min with 2 failures).
- **Integration harness: the full `integration-all.sh` parallel run no longer
  self-inflicts failures.** Root-caused 2026-06-27: platform-api stays up through
  the whole parallel group — its only restarts come from `postgres-pitr`'s
  by-design system-db recreate in the terminal serial phase, not parallel load.
  Two test-side fixes remove the remaining noise: (1) the control-plane barrier's
  `set -e` no longer leaks out of the serial group and abort the entire run on a
  single platform-api blip; (2) rate-limit contention is absorbed — all 12
  parallel suites share one admin identity (so one global-limiter bucket) and one
  source IP, so the `pvc` suite's tenant DELETEs now retry transient 429s, and the
  **staging overlay** raises `API_RATE_LIMIT` + `AUTH_LOGIN_RATE_LIMIT_MAX` for
  the synthetic batch (staging only — production keeps the defaults; the
  rate-limit-testing suites are unaffected).

## [2026.6.16] - 2026-06-22

### Added
- **In-cluster Dex restored on staging for OIDC integration testing.** ADR-053 made the
  staging overlay a pure mirror of production, which (correctly) has no in-cluster Dex —
  but that also removed the ability to test the OIDC flow on staging. Dex is now a
  staging-only delta (`k8s/overlays/staging/dex/`); production still ships no Dex
  (`ci-no-dex-in-production.sh` stays green). Side effect: un-sticks the base oauth2-proxy
  on staging, whose `wait-for-dex-discovery` init was blocking on the pruned issuer.

### Changed
- **Admin node-terminal is now ENABLED in production** (`overlays/production`). It's a
  break-glass tool operators need and is HA-safe with no extra config: the single-use
  `wsToken` is validated against the Postgres `node_terminal_sessions` table (any
  platform-api replica serves any session — the old in-memory design that required
  single-replica/stickiness is obsolete), and base already sets the platform-api Service
  `sessionAffinity: ClientIP`. Still gated by the 30-min OIDC step-up + 256-bit single-use
  60s wsToken.

### Fixed
- **bootstrap: Stalwart auth probe now retries a transient `000`** instead of refusing to
  bootstrap (exit 1). The mail pod can be momentarily unreachable (host-port
  rolling-update gap / admin listener lagging the rollout-ready signal); retries up to
  10×6s before giving up.
- **smoke-test.sh no longer lets `../.env.local` clobber caller-provided creds.** A local
  `.env.local` was overriding the `ADMIN_PASSWORD`/`API_URL`/`ADMIN_EMAIL` exported for a
  REMOTE cluster, 401'ing the smoke gate with local-dev creds. The caller's env now wins.

## [2026.6.15] - 2026-06-22

### Added
- **k3s multi-minor auto-step (R21, ADR-045 dec. 21).** `platform-ops cluster upgrade --version <target>`
  now splits a multi-minor jump into serial single-minor hops automatically — it resolves each
  intermediate minor's latest patch from the k3s release channel, applies the SUC Plans, and waits
  for every node to reach that minor before the next hop (the final hop rolls async). Single-minor /
  patch upgrades are unchanged. The per-hop generator still refuses skip-a-minor as the safety net.
- **Release-candidate Flux re-pin (R22, ADR-045 dec. 12 — Mode B).** The platform upgrade re-pin now
  accepts a `-rc.N` tag, gated by `auto_update_include_prereleases` (default ON staging / OFF prod).
  A staging cluster with the flag on re-pins Flux from the `development` branch to the newest
  release-candidate tag (the poller already selects RCs); production refuses an `-rc.N` tag even via
  an explicit `--version <rc>`. Apply stays operator-gated (no auto-apply loop added).
- **Tenant provision-on-activate model.** `POST /tenants` now creates a tenant `pending` +
  unprovisioned (no auto-provision); provisioning is explicit (admin "Provision Now" or
  `POST /admin/tenants/:id/provision`) and flips the tenant to `active` on completion. Non-active
  tenants are blocked from deploying workloads, configuring domains/ingress, and setting up email
  domains/mailboxes with a clear `TENANT_NOT_ACTIVE` (409). Fixes tenants stuck `pending` forever and
  the downstream `452 4.3.1 mail system full` their mailboxes hit. Admin UI: "Provision Now" in the
  create-success dialog + a not-provisioned warning banner on the tenant detail page.

### Fixed
- **ADR-053 cutover: bootstrap applied the wrong overlay for `--env staging`.** The stale
  `staging → development` overlay remap applied the development overlay's 20Gi system-db patch while
  Flux reconciled the 2Gi staging (production-mirror) overlay → CNPG rejected the storage shrink →
  the platform Kustomization deadlocked `Ready=False`. bootstrap now mirrors `install_flux`'s
  env→overlay mapping exactly (dev→`development`, staging→`staging`, production→`production`).
- **Multi-node HA mail was unreachable on the non-active server nodes.** The `stalwart-mail` Service
  used `externalTrafficPolicy: Local`, so kube-proxy dropped externalIP mail traffic
  (:25/:465/:587/:993) on every node without a local Stalwart endpoint — i.e. exactly the HAProxy
  nodes the externalIPs land on. Changed to `Cluster`; the HAProxy DaemonSet's send-proxy-v2 still
  re-injects the real client IP, so SPF/DKIM source IP is preserved. (Surfaced by the ADR-053
  production-mirror staging; the development overlay had masked it by stripping the field.)
- **Per-tenant file-manager was broken on every non-dev cluster (ImagePullBackOff).** The production
  `platform-config` overlay was missing the `file-manager-image` override, so the base ConfigMap's
  bare `file-manager:latest` resolved to `docker.io/library/file-manager:latest` (does not exist).
  Added the GHCR override to the production overlay (the dev overlay already had it). Surfaced by the
  ADR-053 production-mirror staging.

### Security
- **Upgraded k3s v1.33.10 → v1.35.5+k3s1** (Kubernetes stable channel) to cut base-OS CVEs in the
  kube image stack. Rolled minor-by-minor (1.33 → 1.34.8 → 1.35.5) via system-upgrade-controller on
  the staging HA cluster; smoke 35/0, all nodes Ready, CoreDNS healthy after each minor.
  > **Upgrading existing clusters:** k3s is SEQUENTIAL — step ONE minor at a time
  > (`platform-ops cluster upgrade --version <next-minor> --apply`, validating between). The plan
  > generator and auto-update both refuse skip-a-minor; do not jump multiple minors in one step.

## [2026.6.14] - 2026-06-20

### Security
- **Roundcube webmail rearchitected to fpm-alpine + nginx sidecar (0 CVE).** The
  official apache image is Debian-based (700+ HIGH/CRITICAL base-OS CVEs even at
  1.6.16); replaced with the fpm-alpine image (0/0) served by an nginx:1.30-alpine
  sidecar (also 0/0). Verified on testing: serves end-to-end (login page, PHP,
  Postgres session, POST, branding, deny rules) and scales up/down correctly with
  the `default_webmail_engine` setting via the webmail-router reconciler.
- **Refreshed upstream images to cut base-OS CVEs** (~1650 → ~350 across the
  fleet): roundcube, alpine/k8s 1.33.3/.4→1.33.13, modsecurity-crs date-build,
  frps v0.62.1→v0.69.1, curl 8.10.1→8.20.0, oauth2-proxy v7.15.3, valkey 8.1-alpine.
  Each scanned to confirm the reduction; deployed + smoke-tested (35/0) on testing.
- **Upgraded Calico v3.31.5 → v3.31.6** (CNI patch). Deployed + verified on the
  staging cluster (rolling calico-node upgrade, all nodes Ready throughout, DNS +
  cross-node pod connectivity + ingress all healthy).
- **Upgraded Traefik chart 40.2.0 → 41.0.0** (app v3.7.1 → v3.7.5). The chart-major
  breaking changes are only the `logs.*`/`accessLog.*` value-key renames, which our
  install doesn't set — verified by upgrading with our user-supplied values only
  (not `--reuse-values`, which carried chart-40 defaults the new schema rejects).
  Deployed + verified on staging: DaemonSet rolled 4/4, modsecurity + crowdsec
  plugins reloaded, ingress 200, WAF blocks a SQLi probe (403).
- **Upgraded sealed-secrets chart 2.17.4 → 2.18.6** (controller 0.31.0 → 0.37.0).
  Deployed + verified on staging: controller 1/1 on 0.37.0, the sealing key
  persisted and was re-registered on startup (existing SealedSecrets stay
  decryptable), HTTP server serving, no errors.

### Changed
- **image-cve-scan is report-only while the base-OS-CVE backlog burns down**
  (`REPORT_ONLY=true`): unwaived HIGH/CRITICAL warn but don't fail the run; a
  scan-infrastructure failure still fails hard. Flip to enforcing once cleared.

## [2026.6.13] - 2026-06-20

### Added
- **Upstream-image Trivy CVE scan in CI (ADR-050).** New weekly + on-demand
  `.github/workflows/image-cve-scan.yml` Trivy-scans the upstream images we deploy
  (Stalwart, Postgres, CrowdSec, …) for OS/library CVEs the version+advisory watch
  can't see — entirely in CI, no cluster resources. Pinned + checksum-verified
  trivy binary; skips findings already tracked in `security/cve-ledger.yaml`; fails
  the run on a new untracked HIGH/CRITICAL. Closes the gap that left the Stalwart
  image's Debian base-OS CVEs (e.g. openssl heap-UAF, perl-archive-tar path
  traversal) unscanned. Helpers: `scripts/list-scan-images.sh`,
  `scripts/cve-ledger-trivyignore.py`, `scripts/trivy-scan-summary.py` (unit-tested).
- **`component-watch.sh --changelog <id>`** — surfaces the upstream release notes
  between a component's pinned version and latest, flagging breaking/migration
  notes, with open-issues + compare links. Required before bumping a tier-0 pin.

### Changed
- **Component-watch weekly sweep now leads with a ⚠️ Tier-0 (critical) components
  behind upstream callout** so critical drift (e.g. the Stalwart mail server, which
  had quietly fallen four releases behind) surfaces immediately instead of being
  buried in the rolling tracking issue.

### Security
- **Upgraded the Stalwart mail server v0.16.5 → v0.16.9** (was 4 releases behind).
  Cuts the image's HIGH/CRITICAL CVE count from 26 → 15; the remaining 15 are
  Debian base-image CVEs (perl-base, libsqlite3, curl, libssh2, ncurses) with no
  fix in the latest upstream release, all outside the mail daemon's runtime path
  (Rust binary on the RocksDB store) — triaged `not_affected` in
  `security/cve-ledger.yaml`. Verified on testing: RocksDB store intact, all
  SMTP/Submission/IMAP/IMAPS/JMAP listeners serving, 0 restarts.

## [2026.6.12] - 2026-06-19

### Added
- **Lockout-prevention bridge on Security → Posture → Firewall Posture.** When
  your current connection's source IP isn't in any trusted range, the tab warns
  (locking down SSH / enabling L4 enforce would lock you out) and offers a
  one-click "add my IP" to the cluster trusted ranges. The IP is derived
  server-side from the Traefik-set X-Real-IP (never the request body),
  host-scoped (/32 or /128), super_admin-gated.
- **Bulk-apply NetworkPolicy hardening templates to tenant namespaces** (Security
  → Posture → Network Policies). Three egress-restricting templates —
  *isolate-tenant*, *deny-all-egress*, *allow-dns-only* — that compose on top of
  the ingress-only tenant baseline. Dry-run preview shows the exact affected
  namespaces before a type-to-confirm apply; one managed policy per namespace
  (`insula-hardening-egress`), reversible via Remove. Auto-skips the SYSTEM
  tenant, opt-out namespaces (`insula.host/netpol-hardening=optout`), and any
  namespace with a custom egress policy. Calico enforcement live-proven. Runbook:
  [SECURITY_HARDENING.md](docs/operations/SECURITY_HARDENING.md#networkpolicy-hardening-templates-network-policies-tab).
- **Restore a tenant from a retained Longhorn volume.** A destructive shrink (or
  archive) leaves the old volume detached + `Released` with its snapshots intact
  (`longhorn-tenant` is `reclaimPolicy: Retain`). The admin tenant-detail page now
  has a **"Restore from a retained volume"** card that lists those volumes + their
  snapshots and rolls the tenant back onto a chosen one (quiesce → Longhorn
  `snapshotRevert` → rebind PVC by `volumeName`, raising the storage quota if
  needed). The volume in use is kept as a `Released` fallback — reversible. This
  is the recovery path for the `SNAPSHOT_VOLUME_MISMATCH` case the in-place revert
  refuses. The orphaned-volumes reaper now skips a `Released` volume that still
  holds a restorable snapshot, so a fresh retained fallback is never auto-purged.
  Runbook: [TENANT_SNAPSHOTS.md](docs/operations/TENANT_SNAPSHOTS.md).
- **Offline etcd restore now works for every shim upstream protocol — S3,
  SFTP, and CIFS/SMB** (it was S3-only). `restore-etcd-from-shim.sh --offline`
  renders a private per-run `rclone.conf` for the descriptor's `storageType`;
  SFTP/SMB passwords are rclone-obscured and all credentials live in the 0600
  conf, never on the command line. Proven against real Hetzner S3 / SFTP /
  CIFS, including a destructive cluster-down recovery over CIFS.

### Fixed
- **Force-cancelling a storage op no longer leaves the tenant's workloads scaled
  to 0.** `quiesce` now persists the pre-quiesce replica snapshot *before*
  scaling anything down (capture → persist → apply), so `…/storage/cancel` (or a
  crash) mid-op always has the data to bring every workload back to its prior
  replica count — previously a cancel that raced the post-quiesce persist found
  the tenant DOWN with no record of its replica counts (manual `kubectl scale`
  recovery). All quiesce-based ops (resize/shrink, restore, retained-restore,
  suspend, archive, fsck) benefit; fsck now persists a snapshot it didn't before.
- **Destructive PVC shrink no longer hangs at "Scaling workloads to zero" on a
  single node.** Three layered bugs: (1) the `@kubernetes/client-node`
  serializer silently dropped `replicas: 0`, so quiesce's scale-to-0 was a no-op
  (now done via a raw merge-patch to the `/scale` subresource); (2) the
  file-manager auto-restarted within ~2s and fought quiesce (quiesce now stamps
  an `insula.host/storage-quiesced` annotation that blocks the auto-start until
  the op finishes); (3) a pod stuck `Terminating` on a slow Longhorn unmount kept
  the PVC's RWO lock (now force-deleted past a grace window). Shrink — and every
  quiesce-based op (in-place / retained restore, fsck) — now succeeds first-try.
- **The off-site etcd restore (`restore-etcd-from-shim.sh`, both online and
  offline) called a nonexistent `k3s etcd-snapshot restore` subcommand** and
  would have failed *after* downloading the snapshot — the worst time, mid
  disaster. k3s has no such subcommand; restore is a server-reset op, so it now
  runs `k3s server --cluster-reset --cluster-reset-restore-path=<snapshot>`
  (matching the local Tier-0 path). Operator docs that referenced the
  nonexistent command are corrected.
- **The secrets-bundle export silently omitted `dr-system-target.json`** — the
  descriptor the OFFLINE etcd restore reads — unless `PLATFORM_ENCRYPTION_KEY`
  happened to be on `app.config`. It now falls back to `process.env`, so the
  bundle always carries the descriptor when a SYSTEM target is bound.
- **`platform-ops dr preflight`** only recognised S3 `endpoint =` lines when
  checking that the off-site target is external, so it falsely warned on an
  SFTP/SMB (`host =`) upstream. It now matches both.

### Changed
- **platform-ops' embedded break-glass scripts are single-sourced from one
  manifest** (`backend/src/cli/platform-ops/embedded-scripts.ts`): the CLI
  dispatch (typed), the binary build, and a new CI guard
  (`ci-platform-ops-embed-check.sh`) all derive from it, so the signed binary,
  the CLI, and the on-disk scripts cannot drift apart. Internal — no
  operator-facing change.

## [2026.6.11] - 2026-06-16

### Added
- **Disaster-recovery break-glass: tiered etcd restore that works when the
  cluster is DOWN (R20 follow-up).** The off-site etcd restore used to need
  `kubectl` (to read the shim ClusterIP + creds) — but in a real etcd disaster
  the kube-API is down, so the one restore you need most couldn't run. Now there
  are three tiers, tried in order:
  - **Tier 0** `restore-etcd-local.sh` (+ `platform-ops dr restore-component etcd
    --local`) — restore from this node's local k3s snapshots; no network, no
    kubectl, no shim. The first thing to try when the disk survived.
  - **Tier 1** `restore-etcd-from-shim.sh --offline --bundle <secrets-*.tar.age>
    --age-key <key>` — pulls the off-site snapshot DIRECTLY from the real
    upstream S3, with no kubectl. It reads the decrypted `system` target from a
    new `dr-system-target.json` carried inside the age-encrypted secrets bundle
    (emitted by `/admin/system-backup/export-secrets-bundle` when a SYSTEM target
    is bound). S3 upstreams; the credential travels via env, never argv.
  - **Tier 1b** the existing kubectl→shim path (cluster up), unchanged.
  - **`platform-ops dr preflight`** reports, per tier, whether each restore would
    actually work — run it ahead of a disaster. Runbook:
    [BACKUP_RCLONE_SHIM.md](docs/operations/BACKUP_RCLONE_SHIM.md#recover-etcd--tiered-break-glass).
- **Per-file / per-folder restore from tenant backup bundles (#105).** The files
  component is now captured as a restic tree, so the restore cart can browse a
  bundle (`GET …/tenant-bundles/:id/browse/files/tree?path=` — lazy, one
  directory per call; admin + tenant) and restore a selection via a `files-paths`
  cart item (`{ kind: 'paths', paths: […] }`, up to 10 000 paths) instead of the
  whole archive. Restore is a restic-native overlay (`restic restore --include …`
  → `cp -a`, idempotent overwrite, no delete) with a pre-restore snapshot taken
  for rollback. Documented in [TENANT_BACKUP.md](docs/operations/TENANT_BACKUP.md).
- **platform-ops CLI E2E coverage in the staging suite.** Extended
  `integration-platform-ops-cli-e2e.sh` to assert the read-only / idempotent R18
  surface (`version`, `cluster doctor`, `backup key-status`, `backup target list`
  + idempotent re-bind) and wired it into `integration-staging.sh` as a
  `platform_ops` scenario (the destructive domain-rename leg stays opt-in).
- **Operator runbooks** for three shipped subsystems:
  [PLESK_MIGRATION.md](docs/operations/PLESK_MIGRATION.md) (R1),
  [TENANT_SNAPSHOTS.md](docs/operations/TENANT_SNAPSHOTS.md) (R19), and
  [PLATFORM_DOMAIN_RENAME.md](docs/operations/PLATFORM_DOMAIN_RENAME.md) (R16);
  roadmap + changelog reconciled to match what's actually shipped.

### Changed
- **The `mail-backup-tools` image is renamed `tenant-backup-tools`** — it now
  backs tenant-bundle files/mailboxes, the Plesk mail/discovery legs, and restic
  file restore. Override env vars are unchanged (`PLESK_MAIL_TOOLS_IMAGE`,
  `PLESK_DISCOVERY_IMAGE`, the tenant-bundle tools-image vars).

## [2026.6.10] - 2026-06-15

### Added
- **`platform-ops` operator-CLI additions (R18 consolidation).**
  - `cluster doctor` — per-node readiness/drift check (platform-ops version,
    cosign trust anchor, host-config kubeconfig, cluster reachability, rclone,
    host-migration markers, nodes-ready). Exit 1 on any FAIL; `--json`.
  - `backup target list|add|test|delete|bind|unbind` — manage backup targets +
    class bindings from a node (runs in the platform-api pod), removing the need
    to mint an admin JWT and hand-craft REST calls. `add` takes the config JSON
    on stdin (secret never in argv); list strips credentials.
  - `backup key-status` — show the BACKUP_TARGET_KEY fingerprint + rotation
    times (read-only companion to `backup rotate-key`).
  - `mail rotate-master-password` — rotate the Stalwart webmail master password
    (recovery; runs the same JMAP rotation the admin panel does, rolls Roundcube).
  - `cluster diagnostics` now includes the on-node nft firewall posture.
- **Worker nodes can now run host-config (host-migrations / package converge).**
  Worker hosts have no k3s admin kubeconfig (`/etc/rancher/k3s/k3s.yaml` is
  server-only), so `platform-ops host-config` was a permanent "cluster
  unreachable" no-op there — host-migrations (e.g. the rclone backfill) never ran
  on workers. A new `host-config-reader` ServiceAccount (RBAC: `get` on exactly
  the 5 desired-state ConfigMaps, name-scoped, no list/write) plus a tiny
  workers-only `host-config-kubeconfig` DaemonSet writes a least-privilege
  kubeconfig to `/etc/platform/host-config/kubeconfig` on each worker host (the
  DaemonSet has zero network, drops ALL caps, and can only write that subdir —
  never the cosign trust anchor at `/etc/platform/cosign.pub`). The converger now
  falls back to that kubeconfig after the k3s admin one. New CI guard pins the
  least-privilege contract (`ci-host-config-check.sh`). Security-reviewed: no
  critical/high; documented hardening follow-ups — an expected-apiserver anchor
  to validate the kubeconfig `server` (defense-in-depth vs a compromised writer
  pod) and `bootstrap.sh` ensuring `/etc/platform/host-config` is a real dir
  (anti-symlink). The busybox writer image is digest-pinned.

## [2026.6.9] - 2026-06-15

> First production cut since 2026.6.8 (2026-06-09). It captures the accumulated
> development-branch work from 2026-06-11 → 06-14 (continuously deployed to the
> dev cluster) in addition to the 06-15 host-dependency changes below.

### Added
- **Plesk migration service (R1, ADR-052, PRs #70–#89).** A new agentless
  `plesk-migration` module: source registry + SSH discovery (keyfile *or*
  password; discovery fails visibly with a classified reason), provision a
  discovered subscription onto a new or existing sized tenant (capacity
  preflight), and per-leg import of databases (per-tenant MariaDB via a dedicated
  `migration-tools` image), website content (rsync onto `apache-php`, PVC sized
  to the real docroot), mailboxes (IMAP MULTIAPPEND, `new/`→`cur/` reshape
  preserves unread state), cron jobs, and primary-DNS zones. E2E-proven on
  staging against a real Plesk Obsidian source.
- **FBL complaint processing (R4, PRs #64–#69).** Feedback-loop ingestion via
  Stalwart webhooks + `x:ArfExternalReport` — an `fbl@<apex>` SYSTEM mailbox + a
  JMAP poller writing `email_fbl_complaints`, per-domain complaint-rate
  thresholds, and notify/auto enforcement (one-click or automatic throttle +
  outbound-mail suspension), surfaced in Monitoring → Mail. Runbook
  [MAIL_FBL.md](docs/operations/MAIL_FBL.md).
- **Rolling sending-quota enforcement (R6, PRs #64–#69).** Per-tenant plan-based
  hourly/daily send limits via the Stalwart JMAP registry
  (`x:MtaOutboundThrottle` + `x:MtaQueueQuota`, applied with `ReloadSettings`),
  rolling per-hour send accounting (`email_send_counters` fed by send webhooks),
  80/100 % usage notifications + UI, and a Sending-Protection control
  (off / notify / auto). Replaced the dead static `[queue.throttle]` TOML.
- **Monitoring SLO completion (R2, ADR-051, PRs #50–#63).** In-API SLO alert
  evaluator + admin SLOs tab, SLO alerts routed through the categorised
  notification sources, admin-host path routes for VMUI (`/metrics/`) + the
  Longhorn UI (`/longhorn/`) with an HA-replicated metrics volume, and a
  `platform_flux_unready_resources` readiness gauge replacing a Flux-failure rule
  that could never fire.
- **Per-plan maximum mailbox size.** Hosting plans carry `max_mailbox_size_mb`
  (+ per-tenant override); new mailboxes default to it and over-max creation is
  refused (`MAILBOX_QUOTA_EXCEEDS_LIMIT`). Plan codes/names aligned
  (Starter/Premium/Ultimate).
- **Tenant on-server volume snapshots (R19, PRs #90–#102).** A `tenant-panel`
  Snapshots page (list / create / delete via Longhorn CSI) with a 48 h reaper +
  admin expiry, plus **full-volume restore via in-place Longhorn
  `snapshotRevert`** (shared `storage-lifecycle/longhorn-revert.ts`).
- **Turnkey platform-apex rename (R16, 2026-06-13/14).** `platform_domain` split
  from `ingress_base_domain` (migration 0066) + `getPlatformApex()`, and a `POST
  /admin/platform-domain/rename` action + rename UI under which the admin/panel
  IngressRoutes, LE certs, Stalwart web-admin, and the private-worker tunnel
  anchor all follow the new apex (seed-then-disown); the tenant CNAME target is
  unaffected.
- **`platform-ops` operator-CLI — first tranches (R18 T1–T4).** `admin
  reset-password`, `domain rename` (both in-pod — the native-dep graph isn't
  SEA-safe), `dr restore-component <etcd|mail|postgres>` (embedded bash), and the
  T3 housekeeping subcommands (`cluster gc-namespaces|upgrade-cnpg`,
  `component-watch`, `node-terminal gc`, `backup rotate-key`). See 2026.6.10 for
  the R18-finish convenience batch.
- **`rclone` is now a host dependency on every node.** The DR restore scripts
  (`restore-{etcd,mail,postgres}-from-shim.sh`, `platform-ops dr
  restore-component`) run rclone on the host to pull a snapshot from the
  backup-rclone-shim S3 endpoint before a local restore — but it was never
  installed (only the backup *upload* path, which runs in a pod, had rclone).
  Fresh installs get it via `bootstrap.sh` (`install_packages_{apt,dnf}` +
  `install_rclone_if_missing` static fallback for AL2023); existing nodes get it
  via host-migration `2026.6.9/0001-install-rclone.sh` (run because
  host-migrations now default to `enforce` — see Changed). Pinned static
  fallback tracks the shim's rclone line (1.74.1).

### Changed
- **Host-migrations now run by default (`enforce`), no longer opt-in
  (`observe`).** `host-migrations-desired` previously shipped `mode: observe`
  (report-only) so the host-config runner was a strict no-op until an operator
  opted in. Platform-migration `0008` flips it to `enforce` on every cluster
  (new clusters right after the seed; existing clusters on upgrade), so shipped
  host-migration scripts apply automatically (e.g. the rclone backfill above).
  This is safe to default-on: the scripts are platform-authored, CI-validated
  (idempotent + allow-paths-bounded), and embedded in the cosign-signed
  `platform-ops` binary. An operator who wants report-only sets `mode: observe`
  after the upgrade — `0008` runs once and won't re-flip it. The
  operator-content gating policies (`host-packages-/ulimits-/modules-desired`,
  which carry operator-supplied names) stay `observe`.
- **`python3` is now an explicit `bootstrap.sh` dependency and is auto-installed
  if missing.** It was always required (CIDR/IP validation, node-IP pinning,
  admin/backup JSON bodies) but only assumed present; a minimal base image
  failed `--allow-source` validation before `install_packages` ran. Added to
  `install_packages_{apt,dnf}` plus an `ensure_python3` early-bootstrap helper.
- **Backups are namespaced by a stable `cluster_id`** (cross-cluster restore
  safety). A generate-once `cluster_id` UUID (in `platform_settings`, not the
  apex) prefixes the system/postgres, mail-restic, and etcd-snapshot backup paths
  so two clusters sharing one bucket+prefix can't `--latest`-restore each other's
  state. The static postgres ObjectStore + the etcd-snap CronJob are held with
  `reconcile: disabled` (seed-then-disown) so the reconciler's `cluster_id` path
  sticks against Flux. Tenant backups stay cluster-agnostic (migration-ready).

### Fixed
- **Per-mailbox Stalwart quota was never applied.** The JMAP patch used
  `quota/storage` (an invalid patch in Stalwart 0.16) instead of
  `quotas/maxDiskQuota` (bytes) — quotas never reached Stalwart on create *or*
  update. Now set at creation; verified via `x:Account`.
- **Destructive PVC shrink — five-bug chain (PRs #90–#95).** Quiesce now waits
  only on pods mounting the target PVC (a stuck cert-manager solver no longer
  times it out) and actually scales workloads to 0 (the scale-subresource was a
  no-op); the pre-resize capture writes a files-only restic bundle through a
  per-class S3 streaming store (the hostPath store was PodSecurity-blocked under
  baseline PSA); tenant namespaces are labelled so the snapshot/backup Jobs can
  reach the rclone shim; and the failed-op banner clears when the lifecycle rolls
  back to idle.
- **etcd off-box backup silently no-op'd (DR gap).** The etcd-snap CronJob ran on
  a read-only rootfs with no writable `/tmp`, so every off-box upload wrote
  nothing (0 copies). Added an `emptyDir` at `/tmp`; the etcd break-glass restore
  also now resolves the rclone-shim ClusterIP instead of `.svc` DNS (unresolvable
  from a bare node).
- **`/backups/restore` cart crash + Tenant-Backups list 500.** The shared restore
  cart pulled in a second copy of React in the panel image (`Cannot read null` in
  `useState`) — fixed with Vite `resolve.dedupe`. Separately, the admin
  Tenant-Backups list 500'd because `db.execute()` (node-postgres) returns
  `{rows}`, not a bare array, and an `openCart` query referenced a stale enum.

## [2026.6.8] - 2026-06-09

## [2026.6.7] - 2026-06-07

### Changed
- **DKIM selectors are now a fixed alternating pair — `dkim-1` / `dkim-2`**
  ([ADR-047](docs/architecture/adr/ADR-047-dkim-ab-selectors.md), the Microsoft 365
  `selector1`/`selector2` pattern, replacing per-rotation timestamped
  selectors). Rotation flips signing to the other selector with a fresh
  RSA-2048 key; the previous selector's key + TXT record stay live, so mail
  in receivers' retry queues keeps verifying and **no retirement step exists
  anymore** (the rotate response no longer returns `recommendedRetireOldAt`;
  it now returns `previousSelector` + `destroyedSelectors`). Tenants on
  external DNS configure two TXT records once and never touch DNS on
  rotation. Enable + drift-repair now replace Stalwart's auto-created
  `v1-rsa-<date>`/`v1-ed25519-<date>` signature pair with one platform
  RSA-2048 signature under `dkim-1` and publish its TXT record inline
  (previously first published by the next dns-sync cycle). Migration 0051
  adds `email_domains.dkim_active_selector`; existing domains converge onto
  the pair at their first rotation or re-enable.

### Fixed
- **DKIM/DNS hygiene follow-ups** (2026-06-07 E2E findings): the email-domain
  enable flow no longer inserts a junk `._domainkey.<domain>` TXT record with
  an empty selector (M13-era stub); the disable flow now destroys the
  domain's Stalwart `DkimSignature` rows before destroying the principal
  (previously they orphaned in the registry); migration 0050 renames
  `dns_records."recordType"` → `record_type` to end the table's mixed
  column-naming (snake + camel) that broke hand-written SQL.

## [2026.6.6] - 2026-06-07

## [2026.6.5] - 2026-06-07

### Fixed
- **DKIM rotation actually works now + tenant domains are RSA-only.**
  Three fixes on top of the earlier RSA-keygen change: (1) the rotation
  route read the nonexistent `ENCRYPTION_KEY` env var (correct:
  `PLATFORM_ENCRYPTION_KEY`) and 500'd unconditionally; (2) rotation
  POSTed its Stalwart create to `/api/store/import`, which does not exist
  on v0.16.5 — it now uses JMAP `x:DkimSignature/set` (the wire
  stalwart-cli uses); (3) Stalwart auto-creates an Ed25519 signature next
  to the RSA one on every new domain principal — Gmail/M365 can't verify
  RFC 8463 signatures and Gmail reports dkim=fail in tenant DMARC
  aggregates — the enable flow now destroys the auto-created Ed25519 row
  (soft-fail; RSA-only policy, new `email-dkim/suppress-ed25519.ts`).

### Fixed
- **DKIM rotation now generates RSA-2048 keys** (was Ed25519). The rotation
  path was triply broken: Gmail/Microsoft 365 don't support RFC 8463
  ed25519-sha256 (Gmail reports dkim=fail instead of ignoring it), the
  rotated key's TXT record was published with `k=rsa` + SPKI encoding
  (invalid for Ed25519 even at verifiers that support it), and retiring the
  old RSA key per our own 14-day guidance left domains signing Ed25519-only
  — no verifiable DKIM at the largest providers. Rotation now uses the same
  RSA-2048 generator as initial provisioning, making the published DNS
  record correct and every rotated key Gmail-verifiable.

### Removed
- **Stalwart blob-store remnants fully deleted** (follow-up to the ADR-046
  fence): `mail-admin/blob-store.ts` + tests, api-contracts
  `mail-blob-store` schemas, and the orphaned `mail-blob-store` PvcRole.
  Findings live in ADR-046 + STALWART_BLOB_STORE_MIGRATION.md; code in git
  history.

### Added
- **Operator runbook `docs/operations/MAIL_STORE_SPACE_RECLAIM.md`** —
  reclaiming disk after bulk mail deletion (measured: zero reclaim after
  11.5h idle; purge→flush→compaction→blob-unref chain; offline `ldb
  compact` procedure; upstream blob-GC contribution note).

### Removed
- **Stalwart blob-store switch UI + routes fenced (ADR-046)** — the platform
  stays on Stalwart's Default (RocksDB) blob store. The admin-panel
  "Blob store" card (Email → Operations → Storage) and the
  `GET/PATCH /admin/mail/blob-store` + job-status routes were removed after a
  live E2E found the switch inoperative as shipped (config only applies on
  restart; schema-invalid S3 cli fields; self-verify false negatives; CIFS
  host mount never provisioned; Flux strips the runtime Deployment patch).
  The backend module + api-contracts schemas remain in-tree with STALE
  banners. fs→S3 / fs→CIFS blob migrations were proven byte-lossless, so the
  decision is reversible. See ADR-046 and the rewritten
  STALWART_BLOB_STORE_MIGRATION.md.

### Changed
- **Stalwart memory limit raised 512Mi → 1536Mi** (requests 128Mi → 256Mi).
  The 2026-06-05 20GB ingest stress test OOM-killed Stalwart at 512Mi
  (~2GB into a bulk IMAP import; loaded RSS runs 600–850MB at 15GiB of
  stored mail). At 1536Mi the same workload completed with zero restarts.

## [2026.6.4] - 2026-06-06

### Added
- **`make new-host-migration` scaffolder (Tier 3).** Generates a
  contract-complete W10c host-migration stub at
  `platform/host-migrations/<next-version>/<NNNN>-<name>.sh` (next version from
  `cut-release.sh --print-version`, next number auto-picked) — shebang,
  `set -euo pipefail`, both `# idempotent:` / `# allow-paths:` headers, and a
  body that fails loudly until implemented. Refuses to overwrite (order-stable).
- **Release-time host-migration audit in `cut-release.sh` (Tier 3).** The
  release plan now lists the host-migrations + `[no-host-migration]` waivers the
  release contains and re-checks the firewall shape across the whole delta since
  the previous tag; an uncovered shape change (changed, no migration, no waiver)
  **blocks the cut** (override `--allow-uncovered-host-changes`) — defence in
  depth behind the per-PR `ci-migration-coverage` guard.

### Changed
- **Firewall blacklist drop rule is now continuously converged (Tier 2).** The
  `firewall-reconciler` ensures the `@blacklist_v{4,6} drop` input-chain rules
  exist on every tick (netlink, distroless — no `nft` binary), so clusters
  bootstrapped before the blacklist feature self-heal with no one-shot
  migration, and the rule re-asserts after a reboot or out-of-band flush. The
  v2026.6.3 one-shot backfill migration is now redundant (kept; idempotent).

### Fixed
- **Internal images pinned to immutable tags (kill the `:latest` pull-race).**
  security-probe, firewall-reconciler, host-config-reconciler, backup-rclone,
  sftp-gateway and tenant-backup-tools are now pinned to immutable
  `<timestamp>-<sha>` tags in the development overlay (rewritten by each image's
  own build workflow *after* the push, via `pin-image-tag.sh`), instead of
  `:latest` + a deploy-rev bump that raced the image push and could leave pods
  on a stale digest. Flux now only ever rolls to a tag that already exists.
- **Pin commits propagate to the development branch.** Added the six image-build
  workflows to `sync-development`'s `workflow_run` triggers — a pin commit is
  pushed with the workflow `GITHUB_TOKEN`, which does not fire the `push`
  trigger, so without this the pins stranded on `main`.
- **backup-rclone-shim is updatable when idle.** Its readiness is decoupled from
  `:9000` (launcher writes a liveness marker in both the idle and serving
  branches; probe is now `exec [ -f /var/run/backup-rclone/ready ]`). A
  target-less shim correctly idles without binding `:9000`, so the old
  `tcpSocket:9000` probe kept it NotReady and stalled a DaemonSet RollingUpdate
  (e.g. an image-pin bump) forever. It now reports Ready (alive) so rollouts
  complete, without serving a fake endpoint (no silent backup loss).

## [2026.6.3] - 2026-06-06

### Added
- **Operator firewall blacklist — permanent IP/CIDR bans.** A super_admin
  Network Trust → Blacklist tab (and a "Ban permanently" deep-link from the SSH
  Lockdown fail2ban modal) drops an IP or CIDR on ALL ports, on every node, via
  a new `ClusterFirewallBlacklist` CRD converged by the firewall-reconciler into
  nft `blacklist_v{4,6}` sets — permanent, complementing CrowdSec L4's automatic
  TTL'd bans. Two-layer self-lockout defense (backend + reconciler) refuses any
  ban that would catch a node IP / cluster peer / trusted range / the operator's
  own IP; type-to-confirm; audit-logged. The drop is placed after
  `ct state established,related accept` (an operator who bans their own IP keeps
  the live session) and before any port accept.
- **fail2ban SSH-ban visibility in the SSH Lockdown table.** The read-only
  security-probe now surfaces each node's persisted fail2ban bans (banned-now /
  24h / all-time counts + a per-IP modal: jail, banned-at, expiry, count) read
  from `/var/lib/fail2ban/fail2ban.sqlite3` (read-only, no control socket).
- **Host-migration: firewall-blacklist nft backfill (ADR-045 W10c).** A one-shot
  idempotent per-node migration backfills the blacklist nft sets + drop rules
  onto clusters bootstrapped before the feature (fresh installs get them from
  bootstrap). Applied surgically (never `nft -f`, which would flush the whole
  ruleset and break CNI), persisted for reboot, self-healing on partial failure.
- **CI migration-coverage forcing function (Tier 1).** `ci-migration-coverage.sh`
  fails any PR that changes bootstrap.sh's firewall shape without shipping a
  host-migration backfill (or an explicit `[no-host-migration]` waiver) — so the
  "fresh-render reaches new installs but not existing nodes" gap can't recur
  silently.
- **WAL-archive health monitor + alerting + auto-disable circuit-breaker**
  (`backend/src/modules/wal-archive-health/`; follow-up to the plugin-presence
  fix). Covers the case the presence fix doesn't: a SYSTEM backup target IS
  configured but its sink is unreachable, so CNPG's `wal-archive` fails every
  segment and pg_wal climbs toward a full volume. A 5-min scheduler reads the
  CNPG `ContinuousArchiving` condition + pg_wal pressure (`pg_ls_waldir()`; the
  app role is a `pg_monitor` member) and: (1) **alerts** via the notifications
  subsystem — new admin categories `admin.wal_archive_failing` (error) and
  `admin.wal_archive_auto_disabled` (critical, mandatory); (2) as a last-resort
  **circuit-breaker**, if archiving keeps failing AND pg_wal crosses 75 % of the
  data volume, **auto-disables archiving** (removes the barman plugin →
  `wal-archive` no-op-succeeds → WAL recycles) so the volume can never fill even
  if the alerts go unseen for days. The disable is persisted in
  `platform_settings` and ENFORCED by the `postgres-objectstore` reconciler
  (overriding UI-WAL-streaming ownership); `enableWalArchive`/`enableWalStreaming`
  refuse while tripped. Operators clear it via `POST /admin/wal-archive-health/
  reset-breaker` (super_admin) after fixing the target. The 75 % threshold is the
  sustained-failure guard (it takes many hours of failure to reach it — a brief
  sidecar restart doesn't). E2E-proven on staging.

### Fixed
- **CRITICAL: a targetless CNPG cluster no longer self-destructs by filling its
  volume with un-recyclable WAL.** A freshly-bootstrapped cluster with no backup
  target shipped `archive_mode=on` pointed at the backup-rclone-shim S3 sink,
  which doesn't start until a target is configured — so every WAL archive failed,
  Postgres couldn't recycle WAL, `archive_timeout=5min` pumped ~192 MB/h, and
  pg_wal filled the 10 GiB `system-db` volume in ~2 days → CNPG halted Postgres →
  cluster failure (observed: 17 MB DB, 9.6 GB pg_wal, `pg_stat_archiver`
  archived=0 / failed=6841). Root cause: the platform controlled
  `spec.plugins[].isWALArchiver`, but CNPG keeps `archive_mode=on` for as long as
  the barman-cloud plugin ENTRY is *present* — independent of `isWALArchiver`. The
  `postgres-objectstore` reconciler now manages the plugin entry's PRESENCE (adds
  it when a SYSTEM target is bound, after materializing its ObjectStore; removes
  it otherwise), and `k8s/base/database.yaml` no longer ships a static entry. A
  fresh cluster starts with no barman plugin: with no archiver attached, CNPG's
  `wal-archive` command no-op-succeeds (archive_mode itself stays on — CNPG owns
  that GUC) so Postgres recycles WAL instead of failing against the dead sink.
  CI guard `ci-backup-rclone-shim-check.sh` Invariant 10 now *rejects* a static
  plugin entry. When a SYSTEM target IS bound the plugin is present + real
  archiving and scheduled base backups run exactly as before (the UI WAL-streaming
  path in `system-backup/wal-archive.ts` is unchanged). **Operator note:** deploying
  this to an EXISTING cluster triggers a CNPG-managed rolling Postgres restart (the
  plugin reconcile); a target-bound cluster ends with the plugin present (archiving
  continues), a targetless one with it absent — ~5–15 s single-instance, a
  switchover on HA. Verified on staging: removing the plugin drained pg_wal
  9.6 GB → 641 MB, cluster healthy 3/3, archive failures stopped.

### Added
- **`platform-ops dr` disaster-recovery subcommands** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
  W17, PR 10): `dr verify` (read-only: age-decrypt + print a bundle's manifest —
  no DB, no cluster, runs on a bare jump host) and `dr restore` (`--mode partial`
  imports backup-config rows read-only; `--mode full` runs CNPG recovery + mail
  restore). The host binary wraps the backend `dr-restore` `runDrRestore`
  primitive DIRECTLY — the same module `scripts/dr-restore-bundle.sh` drives —
  so it works when platform-api is down. `--mode full` keeps the per-cluster
  type-to-confirm (`--confirm-cluster <name>`, value === cluster name) + a
  required `--target-mail-node`. Failure output emits a stable error label only
  on stdout `--json` (never the error body, which can carry the age key path or
  a DSN); the full diagnostic goes to stderr with credentials scrubbed. Covered
  by 29 Vitest cases (`dr.test.ts`).

### Changed
- **platform-ops signature verification is now openssl-only on nodes** (no cosign
  on hosts). A cosign `sign-blob --key` signature is plain base64-encoded
  ECDSA-P256/SHA256, which `openssl dgst -verify` validates against the pinned
  public key — so nodes need no 120 MB cosign binary; cosign is a CI-only
  (signing) tool. Replaces the prior node-side `cosign verify-blob
  --insecure-ignore-tlog` approach. `openssl` is now explicit in the bootstrap
  package lists (it was already a transitive dependency).

## [2026.6.2] - 2026-06-01

### Added
- **`platform-ops` operator CLI** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
  W17): a self-contained Node SEA binary (`scripts/build-platform-ops.sh`) that
  imports the backend TS modules directly — no logic duplication. First tranche
  of read-only subcommands: `version` (offline-first; enriches from the DB when
  reachable), `cluster status`, `cluster diagnostics`, `migrations list` (stub
  until the registry ships), and `shell`. `release.yml` builds amd64 + arm64,
  cosign-signs them (offline, key-based), and attaches them as Release assets;
  bootstrap installs + verifies them (see W8). Covered by Vitest unit tests +
  `scripts/test-build-platform-ops.sh` (real build + sign→verify→install
  roundtrip, CI job `platform-ops binary build`).
- **Bootstrap phase library + platform-ops install** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
  W8): `scripts/lib/bootstrap-phases.sh` now owns a `phase_platform_ops` step
  that bootstrap.sh runs at end-of-run on the first server — it cosign-verifies
  and atomically installs the `platform-ops` operator CLI to `/usr/local/bin`,
  persists the trust anchor to `/etc/platform/cosign.pub`, and lays down a daily
  `platform-ops-update.timer`. Best-effort + fail-closed (an unverified binary is
  never installed); a dormant no-op until the release pipeline publishes a signed
  binary. Covered by `scripts/test-platform-ops-install.sh` (CI `shell-unit-tests`).

### Changed
- `bootstrap.sh` now sources `scripts/lib/bootstrap-phases.sh`; the legacy
  single-file `curl | bash` install one-liner is no longer supported (clone the
  repo or use `--remote`, both of which already carry `scripts/lib/`).
- `platform/cosign.pub` is committed as the trust anchor for `platform-ops`
  release verification (see [RELEASING.md](RELEASING.md) to provision the key).

### Fixed
- `phase_platform_ops` (W8) verify now passes `--insecure-ignore-tlog` so
  key-based verification works **offline** (releases are signed without a Rekor
  log entry; the pinned public key is the trust anchor) — without it the
  cluster-down install path failed "signature not found in transparency log".
- `phase_platform_ops` no longer uses a `RETURN` trap for temp cleanup (it
  leaked past the function and re-fired on the caller's return with out-of-scope
  vars under `set -u`); cleanup is now explicit at each return.

## [2026.6.1] - 2026-06-01

### Added
- **Version spine** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)):
  `platform/VERSION` (CalVer) is the single source of truth, flowing through CI →
  the `platform-version` ConfigMap → backend → DB → `GET /api/v1/admin/platform/version`,
  which now returns `{ installed, running, available }`. The backend persists
  `installed_platform_version` on startup.
- **Release cycle**: `scripts/cut-release.sh` (CalVer computation, CHANGELOG
  promotion, annotated tagging), this `CHANGELOG.md`, and `RELEASING.md`.
- **OSS readiness**: AGPL-3.0 `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`,
  issue/PR templates, a rewritten top-level `README.md`, and per-component READMEs.
- **Image-org fork-safety**: image-building workflows derive their push org from
  `${{ github.repository }}`; `scripts/preflight-image-org.sh` repoints the
  kustomize tree for fork deploys; CI guard `scripts/ci-image-org-check.sh`.

### Changed
- `build-deploy.yml` computes the development build version from `platform/VERSION`
  (was `git describe`), so the deployed version is CalVer (`2026.6.1-<sha>`).
- `release.yml` no longer opens a PR to a `stable` branch; production Flux pins a
  tag directly. Release notes now come from the matching `CHANGELOG.md` section.
