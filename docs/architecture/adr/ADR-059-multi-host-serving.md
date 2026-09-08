# ADR-059: Multi-host serving — one web runtime, many sites

**Status:** Accepted (2026-09-08)

A runtime deployment serves one route from one document root. This ADR lets one
deployment answer several ingress routes, each from its own folder on the
tenant's storage, without changing what a route is.

## Context

Every hostname a tenant wants to serve requires its own deployment. A runtime
pod reserves its memory whether it is busy or not — memory `request == limit`
under ADR-037 — so ten small sites reserve ten times the runtime's floor. That
floor is not small: the apache-php image claims 64MB of shared opcache at
startup on top of the FPM master and the Apache parent.

The cost is paid per *site*, but it is a property of the *runtime*. What grows
with real traffic is the number of requests being served at once — the FPM
worker count — not the number of sites. Measured on the apache-php image, twelve
trivial sites in one container held **39 MiB** under load, against
**12 × 128Mi** hard-reserved as twelve deployments. On the cluster, a four-site
instance measured **34Mi** against **512Mi** reserved.

Two constraints shaped everything below:

- `ingress_routes` already supports N routes → 1 deployment. Nothing needed to
  change about what a route *is*; the gap was entirely inside the container,
  which had no way to map Host → document root.
- The platform is multi-tenant, but a tenant's sites are not isolated from each
  other in any existing sense: they already share one PVC, one SFTP jail and one
  file manager. The isolation boundary is the tenant, not the site.

## Decision

### Capability is declared by the catalog, never inferred

A catalog manifest carries a `multihost` block naming the config flavour, the
document roots, the include directory, and the validate/reload argv. Its
**presence** is what makes an entry eligible.

The tempting alternative was to infer eligibility from the existing `web_server`
field — every `apache` or `nginx` entry is a web server, after all. Rejected: an
image whose config layout has no include directory would then advertise a mode
it cannot honour, and the failure would appear as sites that silently do not
serve.

**The platform renders the config text; the manifest only says where to put
it.** Admins can add third-party catalog repositories, and a repo that could
supply vhost *text* would be supplying arbitrary directives inside a tenant's
web server. Declaring a reload command is strictly less power than choosing the
image, which a catalog already does.

### The folder is explicit route data, not a naming convention

`ingress_routes.site_folder` holds a path relative to the tenant PVC **root** —
the same convention as `deployments.extra_mounts.folder`, which is why any
folder the tenant can see in the file manager can serve a hostname rather than
only children of the deployment's own `storage_path`.

The first design used a convention: folder name == hostname, with no new column.
It was rejected because it cannot express any of the three things operators
asked for first:

- a **wildcard** route serving one chosen folder (a convention needs a folder
  per concrete hostname, which is unbounded and unknown);
- changing **`wwwRedirect`** without renaming a folder (the canonical hostname
  changes, so the folder would have to move with it);
- folder names that outlive a domain rename.

A related early proposal — symlinking `www.<apex>` to `<apex>` for aliases — was
also dropped: `wwwRedirect` already handles apex+www at the edge, including the
certificate SAN, and a second mechanism for the same problem is a liability.

### The vhost is named after the CANONICAL hostname

`wwwRedirectHosts()` splits a route into canonical + alternate. The alternate
router carries only the redirect middleware and **never reaches a backend**, so
the container only ever sees the canonical name. Rendering `route.hostname`
would produce a vhost that nothing matches whenever a www-redirect is set. One
helper decides it for both the Traefik router and the vhost, so they cannot
disagree.

Two routes whose canonical names collide — including a collision *produced* by
`wwwRedirect` rather than by identical spelling — are a conflict: the first is
rendered and the second is reported, never both.

### Delivery: ConfigMap → wait for projection → validate → graceful reload

The generated vhosts live in one ConfigMap per deployment, mounted (optional,
read-only) over the image's include directory.

- **The ConfigMap is the only source.** A pod that restarts mounts it and comes
  up correct with no help from the platform. Exec-ing config into a running pod
  cannot offer that: after a restart it would serve the catch-all until
  something noticed and pushed again.
- **The wait is real, not a sleep.** Reloading before kubelet has projected the
  files reloads the *previous* generation and every signal says it worked.
- **Validate always precedes reload.** A reload is the one moment a bad vhost
  can take a tenant's running sites down; on a failed check the server is left
  alone and keeps serving the last good config.
- **The ConfigMap is replaced, not patched.** A merge patch leaves keys that are
  no longer rendered, so deleting a route would leave its vhost behind and the
  site would keep answering.

Cost: kubelet's projection delay before a new site answers. Measured on
production at **~60 seconds** — kubelet's sync period, which is the honest
figure. An earlier "~5s" here came from a single lucky sample on DEV taken just
after a sync; one fast observation does not establish a fast path.

That delay is inside the noise of DNS and certificate issuance for a NEW
hostname, so it is acceptable for the site to go live — but it must not be spent
inside an HTTP request. Doing the wait and reload inline made a route PATCH run
~52s on DEV and 59s on production, long enough to come back as a Traefik 502 for
a change that had actually applied: a tenant saw an error for a save that
worked, and a deployment DELETE inherited the same cost. So the request path
writes the ConfigMap — the durable source — and returns, leaving the wait and
reload to run detached. Deferring is safe precisely because of the ConfigMap
property above: a pod restarting at any point comes up serving the new sites
whether or not the reload landed. The reload only shortens the wait for a pod
that is already running.

### Enabling is the only restart

The flag lives in a column, not in `configuration`. Config keys flow through the
pod template, so every change would restart the app; this flag drives generated
ConfigMap content delivered by a reload. Adding, changing and removing sites
never restarts anything — verified under live load: 400/400 requests to
already-serving sites returned 200 across a reload, on each flavour.

Toggling the flag itself *does* restart once, because it changes the pod's
mounts. That is stated in the UI rather than hidden.

### Enabling mounts the tenant PVC root

A route may name any folder, so the pod needs the storage root at a fixed path
(`sites_root`), with no subPath. This widens what that pod can read to the whole
of the tenant's own storage.

That is the same trust boundary SFTP, the file manager and `extra_mounts`
already sit on — one tenant, one PVC — but it *is* a widening, which is why it
is tied to an explicit opt-in rather than applied to every runtime pod. Turning
the flag off while routes still name folders is refused, with the hostnames
listed, rather than silently dropping those sites to the catch-all.

## Consequences

**What multi-host does not change.** Certificates, redirects, WAF, rate limits,
HSTS, mTLS and access control are Traefik middleware attached per *route*, so ten
sites on one instance keep ten independent policies. Verified on the cluster:
enabling HSTS on one route of a three-site pod produced that route's header
(`max-age=31536000`) on that hostname only.

One caveat found while verifying it, worth knowing because it looks like a
leak and is not one: the **apache-php and nginx-php images set their own HSTS
header** (`conf-available/security.conf`,
`max-age=31536000; includeSubDomains`) on every response. A site therefore
carries HSTS whatever its route says, and turning the route setting off does not
remove it. That is pre-existing behaviour — it applies identically to a
single-site deployment — but multi-host makes it visible, because a pod now
serves several hostnames and only one of them may have the platform's header.
static-nginx ships no such header, so the two differ.

**What it genuinely shares.** One PHP version, one `php.ini`, one FPM pool, one
opcache and one restart. Sites needing different PHP versions still need
separate instances, and a runaway script starves its neighbours. The defaults
(`PHP_FPM_PM_MAX_CHILDREN=5`, 64MB opcache) were sized for one site and are now
shared; they remain operator-set, with no autoscaling — a deliberate choice, so
the arithmetic is surfaced in the UI instead of being adjusted behind the
operator's back.

**Backups are unaffected.** The tenant files component runs
`restic backup /source` against the whole PVC, so folders at the storage root
are captured and restorable like any other.

**Per-flavour renderers are a `Record<Flavour, …>`,** so the compiler refuses a
flavour nobody implemented. An unimplemented flavour must fail loudly: emitting
nothing is indistinguishable from "this deployment has no sites".

**Probes must use binaries the image actually has.** `static-nginx` is
distroless — no shell, no coreutils. The projection probe originally ran `cat`
and failed there outright, so the reload never fired and every site silently
stayed on the catch-all while the ConfigMap, the projection and `nginx -T` all
looked correct. The probe is now dispatched per flavour: apache reads the file,
nginx uses its own binary's `-T`, which re-reads the config from disk and prints
it. Anything added later that shells into a workload pod must assume no
userland.

**Not yet exercised: TLS for a multi-host site.** Certificates are per-route and
issuance is gated on domain verification, so the DEV apex — deliberately
unverified since fail-closed DNS verification shipped — cannot exercise it.
Staging on a verified domain is the first place this path runs, including
whether a wildcard route obtains a wildcard certificate.

## Alternatives considered

**Convention-based folders (folder name == hostname).** Zero new state and no
config generation. Rejected: cannot express a wildcard route serving one folder,
forces a folder rename when `wwwRedirect` changes, and ties file layout to
domain names.

**Mass virtual hosting (`mod_vhost_alias` / `root /var/www/$host`).** The same
idea in the web server rather than in the platform, and it works — it was the
first thing proven in a container. Rejected for the same reasons, plus it offers
no place to put per-site policy later.

**Exec-ing config into running pods.** Immediate, no projection delay. Rejected:
a restarted pod serves the catch-all until something re-pushes, and the durable
copy and the live copy become two sources of truth.

**Scale-to-zero per site instead of packing.** Solves idle cost without sharing
a runtime, and keeps full isolation. Not chosen now — it needs request-path
wake-up the platform does not have — and it stays compatible with this design.

## Amendment (2026-09-08) — per-site isolation

The first cut shipped with a defect this ADR did not name: the pod mounts the
tenant PVC **root** at `sites_root`, so **every vhost could read and write the
whole tenant volume** — a sibling site's `config.php` (its database
credentials), and other deployments' data directories, whose mount targets are
`0777`. One compromised site was one compromised tenant.

The original text argued this sat on "the same trust boundary as SFTP and the
file manager". That argument is wrong and is withdrawn. SFTP is authenticated,
deliberate access by the tenant; a vhost is an internet-facing process running
whatever PHP the tenant uploaded. Sharing a volume between those two is not the
same act.

**Two columns, one boundary.** `ingress_routes.app_root` is the sandbox;
`site_folder` remains the document root and must equal it or sit inside it (a
CHECK enforces the pair). The generated vhost sets PHP's `open_basedir` to the
app root, so a site cannot read outside its own application:

- Apache — `SetEnv PHP_ADMIN_VALUE "open_basedir=…"`, which `mod_proxy_fcgi`
  forwards to the pool. Measured against the shipped image.
- nginx — `set $insula_php_admin …` per server block, read by a single
  `fastcgi_param` in the shared include. A *variable*, because nginx inherits
  `fastcgi_param` from an outer level only when the inner level declares none,
  and that location declares several — a server-level param is silently
  dropped. Every generated block must set it: an unset nginx variable is a
  startup error that would take down the whole pod.

**`open_basedir` alone is theatre.** It does not restrain a child process:
with exec available, `shell_exec("cat …/neighbour/config.php")` reads straight
through it — measured, not assumed. So the platform also sets
`PHP_DISABLE_FUNCTIONS` on multi-host deployments, applied by the image in the
**FPM pool**. Pool scope is deliberate: the CLI SAPI keeps exec, so composer,
wp-cli, artisan and `occ` still work from cron and SSH. Single-site deployments
are untouched — they mount only their own subPath and have no neighbour to
reach, so breaking exec there would cost function for no security.

**Why the app root is separate from the document root.** Apps with a `public/`
entry point (Nextcloud, Laravel, Symfony) keep data beside the web root, not
under it. Sandboxing to the document root would cut the app off from its own
`data/`. The operator picks the app root; the document-root picker is confined
to it, so the broken pair cannot be built by hand. Both absolute paths are
surfaced in the UI, because an app's own config file wants them literally.

**Not trusted from the catalog.** The `php` block is validated, not cast:
`/`, any ancestor of `sites_root`, and `:`/newline injection are refused, and
an unusable block fails the whole capability rather than silently serving
multi-host unsandboxed.

**The pod no longer mounts the volume root at all.** The sandbox above confines
the interpreter; this removes the thing it was confining access to. Each served
application root is its own mount with its own `subPath`, so what the pod cannot
see, no missing directive, misconfiguration or future runtime can reach — and
the same now holds for the static runtimes, which have no interpreter to
sandbox and were therefore relying entirely on web-server configuration.

The cost is real and accepted: the set of folders is part of the pod template,
so adding or removing a site restarts the pod, where the volume-root mount could
add one with a graceful reload. `ensureSiteMounts` reconciles the live mount
list on every route change, and deliberately uses read-modify-write rather than
a strategic-merge patch — merge patches key list entries by `mountPath` and can
therefore only ADD, which would leave a folder mounted after it stopped being
served.

**Sessions are per-site, and persist.** Each application root gets its own
directory under `<sites_root>/.insula-sessions/<app root>` — a SIBLING of the
site folders, never a child. Inside the app root it would sit under the
document root whenever the two are the same (the common case) and the web
server would serve `/.insula-sessions/sess_<id>` on request; out here nothing
is under a document root, so no deny rule has to be correct for it to be safe.
A site folder cannot collide with the name, since folder names must start
alphanumeric.

Because the directory is on the tenant volume, sessions now SURVIVE a pod
restart, where `/tmp` lost them. That matters more than it used to: adding or
removing a site restarts the pod, so ephemeral sessions would log every user of
every site out whenever a neighbour added a website. PHP's own GC is enabled in
these images (`gc_probability=1`, `gc_divisor=1000`, `gc_maxlifetime=1440`) and
there is no distro cron overriding it, so files are collected rather than
accumulating — measured, not assumed. A site that stops receiving traffic keeps
its last few session files until it next serves a request; bounded and small.

The directory is created by the init container and pointed at with
`session.save_path` — on Apache through a second FastCGI variable (`PHP_VALUE`,
since `PHP_ADMIN_VALUE` carries `open_basedir` and Apache cannot embed the
newline that separates several), on nginx through the existing multi-line
variable. Sites sharing an application root share the directory, so a login
survives a www redirect.

**Symlinks are not followed**, on all four runtimes. A symlink in one site's
folder pointing at a neighbour's was served by Apache/nginx directly, with PHP
never invoked — so `open_basedir` and `disable_functions`, both interpreter
controls, were bypassed completely. Reproduced against the published images.
The cost is that an application shipping a symlink under its document root
(Laravel's `public/storage`) stops resolving it; neither server can express
"symlinks that stay inside the app root", and the alternative is no isolation
between neighbours.

**Known residue.** PHP's UPLOAD temp files still land in `/tmp`, which is
shared by every site in the pod and must stay inside `open_basedir` or sessions
break. `upload_tmp_dir` is `PHP_INI_SYSTEM`, so it can only be set through
`PHP_ADMIN_VALUE` — which on Apache already carries `open_basedir` and cannot
hold two settings. The window is short and the filenames are unpredictable, so
this is far weaker than the session exposure it replaces, but it is not closed. Closing it needs a
per-site session path created inside each app root, which the reconciler can do
during the exec it already performs — not done here.

**The alternative considered and rejected: per-site FPM pools.** They would
allow per-site `disable_functions` and per-site memory limits, and are the only
road to kernel-enforced isolation. But the images run the FPM master as
`www-data`, and FPM can only `setuid` per pool when the master is root — so
pools deliver no uid separation as things stand, i.e. exactly what
`open_basedir` already gives, while multiplying baseline memory (eroding the
saving multi-host exists for) and forcing an FPM reload that drops opcache for
every site whenever one is added. Revisit only alongside a root FPM master and
per-site uids, which additionally require uid allocation, a `chown` migration
of existing tenant data, and tightening those `0777` directories.

## References

- Catalog: `insulahq/application-catalog` PRs #15, #16
- Platform: PRs #457, #458, #459, #460; isolation amendment #472
- ADR-037 (asymmetric QoS: memory request == limit), ADR-036 (custom
  deployments), ADR-053 (GitOps branches)
- `documentation/docs/tenant/deployments-and-applications.md`,
  `documentation/docs/tenant/domains-and-websites.md`
