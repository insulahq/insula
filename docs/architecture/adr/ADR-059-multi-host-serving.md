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

Cost: kubelet's projection delay before a new site answers — measured at ~5s on
the cluster, bounded by the sync period. That is inside the noise of DNS and
certificate issuance for a new hostname, and it buys a single source of truth.

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
HSTS, mTLS and access control are properties of the *route*, so ten sites on one
instance keep ten independent policies. Verified on the cluster: HSTS enabled on
one site does not appear on its neighbour in the same pod.

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

## References

- Catalog: `insulahq/application-catalog` PRs #15, #16
- Platform: PRs #457, #458, #459, #460
- ADR-037 (asymmetric QoS: memory request == limit), ADR-036 (custom
  deployments), ADR-053 (GitOps branches)
- `docs/tenant/deployments-and-applications.md`, `docs/tenant/domains-and-websites.md`
