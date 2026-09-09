---
verified: 2026.9.12
---

# Deployments & applications

The **Applications** page is where you install the software that powers your
sites: ready-made apps like WordPress, language runtimes like PHP or Node.js,
databases, or your own containers. Each thing you install is called a
**deployment** — your own private, running copy.

Open **Applications** from the left menu. It has three tabs:

- **Installed Apps** — everything you're running now.
- **Catalog** — the menu of things you can install.
- **Custom Containers** — bring-your-own software (if enabled for your plan).

!!! info "Workloads vs applications"
    The catalog has two kinds of building blocks. **Applications** are
    complete, ready-to-use stacks (WordPress, Nextcloud…). **Runtimes** are
    generic engines (PHP, Node.js, a database) you build on top of with your
    own files. Both install the same way.

## Deploy from the catalog

1. Go to **Applications** → **Catalog** tab (or click **Deploy** in
   the top right).
2. Use the search box and the type filter (**All**, **Applications**,
   **Runtimes**, **Static**, **Databases**, **Services**) to find what you
   want.
3. Click a catalog entry to open the deploy dialog.
4. Give your deployment a **name**, fill in any required settings (these vary
   per app — passwords, sizes, options), and confirm.

The new deployment appears under **Installed Apps**. While it starts up it
shows a pulsing **Deploying** status; once ready it shows **Running**.

To make a deployed website reachable, connect a domain route to it — see
[Domains & websites](domains-and-websites.md#point-the-route-at-an-app).

!!! note "Databases and services are cluster-only"
    **Databases** and **Services** are reachable only from inside your other
    applications, never from the internet, so the deploy dialog does not offer
    the *Connect to Unused Ingress Route* step for them and they never appear
    in a route's target list. Your apps reach them by service name — see
    [Environment & connection details](#environment-connection-details).

    This is by design and is not an error condition: a database showing no
    route is healthy.

### Extra mounts

Every app already has its own folder on your storage, mounted where the app
expects it (a website's document root, a database's data directory). **Extra
mounts** let you put an *additional* folder from your storage at another path
inside the container.

In the deploy dialog, open **Extra Mounts** and add a row:

| Field | Meaning |
| --- | --- |
| **Folder** | A folder on your storage, written relative to your storage root — for example `shared-assets`. It is created for you if it does not exist. |
| **Mount at** | The absolute path inside the container where it should appear — for example `/var/www/html/media`. |
| **Read-only** | Tick this to let the app read the folder but not change it. |

Because the folder is relative to your **storage root** rather than to the
app's own folder, two deployments that name the same folder see the same
files. That is the point: a shared media library, a drop-box one app writes
and another reads, or a common asset folder behind several sites.

The same property has a consequence worth knowing:

!!! warning "A shared folder outlives the app"
    Deleting a deployment — even with **delete data** — removes only that
    app's own folder. A folder you mounted as an extra mount stays, because
    another deployment may still be using it. Remove it yourself in the
    **File Manager** when you no longer want it.

A few paths are refused: the container's own system directories (`/usr`,
`/etc`, `/var` and friends) and kernel interfaces (`/proc`, `/sys`, `/dev`),
because mounting over them stops the app from starting. Paths *inside* those
directories are fine. You also cannot mount at a path the app already uses —
the dialog suggests a path underneath it instead.

You can change the mounts of a running app later. Saving restarts it, because
the container has to come back with the new folders attached.

## Several websites on one app instance

A PHP runtime normally serves one website: every hostname routed to it shows
the same files. **Multi-host serving** lets one instance answer several
hostnames, each from its own folder — the way traditional shared hosting works.

It is worth turning on when you run a number of small sites. A runtime instance
reserves its memory whether it is busy or not, so ten small sites as ten
instances reserve ten times the memory. One instance serving ten sites pays the
runtime's fixed cost once; what grows with real traffic is the number of
requests being handled at the same time, not the number of sites.

Not every application supports it. The option only appears for those that do:

| Application | Sites can run |
|---|---|
| **Apache + PHP** | PHP, with `.htaccess` |
| **NGINX + PHP** | PHP |
| **Static (Apache)** | static files, with `.htaccess` |
| **Static (NGINX)** | static files |

A PHP runtime and a static runtime cannot be mixed on one instance — the
instance is the application, and each site is a folder it serves.

**Sites on one instance cannot read each other.** Each is confined to its own
application folder, so a problem with one site does not expose the others' files
or their database passwords. Two consequences worth knowing before you turn it
on:

- Functions that run shell commands are switched off for **web requests** on a
  multi-host instance — that is what stops a site stepping outside its folder.
  Command-line tools over SSH and scheduled tasks keep working normally, so
  `composer`, `wp-cli` and similar are unaffected.
- An app that must run a shell command *while serving a page* needs its own
  instance. Nextcloud's video previews and external SMB storage are the usual
  examples.

### Turn it on

**When deploying:** tick **Multi-host serving** in the deploy dialog. The
instance then starts with everything it needs, and there is no restart at all.

**On an app you already have:** open it under **Applications → Installed** and
use **Multi-host serving**.

Turning it on (or off) restarts the application once, because it changes how
storage is attached. It also gives that instance access to your whole storage
area, so any folder you can see in the file manager can be used as a website.
After that, adding, changing and removing websites happens without a restart —
the running sites are not interrupted.

### Give each hostname its own folder

Go to **Domains → your domain → Routing**. Every route pointed at a multi-host
app gains a folder button next to the app dropdown:

1. Click it to browse your storage.
2. Pick the folder holding that site's files.
3. The hostname serves that folder from then on.

Use **clear** to hand a hostname back to the app's own document root.

A few things worth knowing:

- **The folder is yours to name.** It does not have to match the hostname, and
  renaming a domain never means moving files.
- **Two hostnames can share one folder** — pick the same folder for both.
- **A wildcard route serves one folder** for every hostname it matches, so
  `*.customers.example.com` can front a single application while each visitor's
  address is passed through untouched.
- **Your application still sees the real address.** `HTTP_HOST` and
  `SERVER_NAME` are the hostname the visitor typed, not the folder name, so
  WordPress, Laravel and friends build the right links.
- **Hostnames you have not given a folder** keep serving the app's own document
  root, so nothing breaks while you set things up.
- **Per-site settings stay per-site.** Certificates, redirects, WAF, rate
  limits and access control are properties of the route, so each website keeps
  its own.

### What it does not do

One instance means one PHP version and one set of PHP limits for every site on
it. Sites needing different PHP versions still need separate instances. The
sites also share the instance's memory and worker pool, so a busy site can slow
its neighbours, and restarting the app affects all of them at once.

## Find an installed app

The **Installed Apps** tab has a search box and a grid/list switch in its
toolbar.

- **Search** matches the deployment name, the application it was installed
  from, its type and its status — so `postgres`, `failed` or `database` all
  find what you would expect, not just an exact name. The counter next to the
  box shows how many of your deployments match.
- **Grid** (the default) shows each deployment as a card with live CPU, memory
  and storage. **List** shows a compact table — name, application, status, and
  live CPU, memory and disk — with the same actions; click the name,
  application or status heading to sort by it. These figures are measured live
  per row and are not sortable. CPU and memory are shown for running apps only;
  **disk is shown whether the app is running or not**, because a stopped app
  still occupies its storage. Whichever view you pick is remembered the next
  time you open the tab.

## Manage an installed app

Each deployment is a card on the **Installed Apps** tab showing live CPU,
memory, and storage usage. The card buttons:

| Button | What it does |
|---|---|
| **Stop** / **Start** | Pause or resume the app. Stopping keeps all your data and settings — it just frees up resources. |
| **Preview** | Opens the running app in a sandboxed viewer — **before any domain or route is assigned**. Great for checking that the app came up correctly. The preview link expires after ~15 minutes; app logins/cookies are disabled inside it, and apps that assume they run at a domain root may render without styles. Assign a route for full fidelity. |
| **Details** | Opens the full detail panel (below). |
| Trash icon | Deletes the deployment. Prefer **Stop** if you only want to pause it. |

!!! tip "Stuck while deploying?"
    If something takes much longer than expected, the card switches to letting
    you **Stop** it. Stopping a stuck deployment is safe and preserves your
    data and configuration.

### The details panel

Click **Details** on a card to see and change:

- **Installed version**, creation date, storage path, and the **domain** it's
  attached to.
- **Configuration** — app settings you're allowed to change. Click **Edit**,
  change values, and **Apply Changes**.

    !!! warning "Saving restarts the app"
        Saving configuration restarts the deployment to apply the change, so the
        app is briefly unavailable. Secret values (like passwords set at install
        time) are shown masked — click the eye icon to reveal, and change
        passwords inside the app itself rather than here.

- **Assigned resources** — the CPU and memory reserved for the app (editable
  within your plan limits). Shown directly under **Supported versions**.
- **Volumes** — the **Local path** of each of the app's data folders in your
  file area (for example `/runtime/apache-php/my-site`), alongside the path it
  is mounted at inside the container. Paths are absolute, so they can be pasted
  straight into the file manager or an SFTP client.
- **Terminal** — a shell inside the running app. Paste with ++ctrl+v++,
  ++ctrl+shift+v++ or right-click; ++ctrl+shift+c++ copies the selection.
  ++ctrl+c++ still interrupts a running command, as in any terminal.
- **Logs** — click **Logs** to see recent output. It shows a snapshot by
  default; toggle **Stream Live** to watch new lines as they arrive. This is
  the first place to look when an app misbehaves.

### Updating an app, or changing version

When a newer version is available, the card shows an **Update available** badge.
Open **Details** to review and apply the upgrade. The badge disappears once you
are on the newest version.

**Supported versions** in the details panel lists every version the catalog
offers, with the installed one marked. Click any of them to switch — including
an **older** version, which replaces the previous one-step "Roll back" button.
You are asked to confirm first.

!!! warning "Going back a version does not undo data changes"
    Switching to an older version redeploys the app on that release. Database
    schema changes made by the newer version are **not** reversed, so take a
    backup first if the app stores data. Some apps also restrict which versions
    can be reached directly — if so, the panel says which.

### Restoring a deleted app

Deleted deployments move to a **Recently Deleted** section. Click **Restore** to
bring one back, or use the trash button there to remove it permanently. When
permanently deleting you can also choose to remove its data folder.

That folder goes to the file manager's
[recycle bin](files-and-sftp.md#recycle-bin), so the files stay recoverable for
the retention window — but they also keep counting against your storage until
then. Tick **Delete permanently** in that dialog to skip the bin and free the
space straight away.

!!! note "Restoring the folder does not restore the app"

    Recovering the data folder from the recycle bin returns the *files* only.
    The deployment itself is gone once permanently deleted; you would deploy it
    again and point it at the recovered folder.

## Custom containers (bring your own)

If your plan allows it, the **Custom Containers** tab lets you run your own
container images instead of catalog apps. Two ways:

=== "Single container (New Container)"

    Click **New Container** and follow the wizard to run one image (for example
    `nginx:1.27.5`). Good for a single service.

=== "Multi-service stack (New Stack)"

    Click **New Stack (compose)** to define several services together using a
    Docker-Compose-style editor. Good for an app plus its database, cache, etc.

### Private images

If the image lives in a private registry, tick **This image is in a private
registry** while creating the container or stack and fill in the registry host
(`ghcr.io`, `docker.io`, `registry.example.test:5000`), your username, and a
token with read access to the package. The credential is stored encrypted and
applied *before* the first pull, so a private image starts on the first
attempt — you no longer have to create the container, watch it fail, and add
the token afterwards.

The token is checked against the registry before the container is created, so a
wrong, expired or under-scoped token is reported while you are still in the
form rather than showing up later as `ImagePullBackOff`. If the registry is
temporarily unreachable the check is skipped with a warning rather than
blocking you. It is only ever sent to the registry host you
named — a stack mixing a private registry with public images (`redis:7`, say)
never offers your token to the public one.

To rotate or remove a credential later, use the registry-key button on the
container's row. Saving again from that button **replaces** the stored
credential — it does not add a second one.

A stack has **one** credential, for one registry host, and every service in the
stack is given it. That is fine for the normal case: services pulling from the
private registry use it, and services pulling public images (`redis:7`,
`postgres:17`) ignore it and pull anonymously. What is *not* supported is a
stack whose services pull private images from **two different** registries —
only the host you named will authenticate. Publish the odd image out to the
same registry, or make it public.

### Reading validation errors

**Validate** runs your stack through the parser without creating anything. It is
safe to press at any time, including before you have named the stack.

Each problem it finds appears in the **Issues** panel with:

- a **line N** button — click it and the editor scrolls to that line and puts
  the cursor there;
- the **code** (e.g. `COMPOSE_FIELD_REJECTED`), stable enough to search for;
- the **path** into your document (e.g.
  `services.db.deploy.resources.limits.memory`), which tells you the exact
  field even when several services look alike;
- a **hint** on what to use instead, where one applies.

The same problems appear as underlines in the editor itself — hover one to read
the message without leaving the YAML.

If an issue has no **line** button, the problem is not in the YAML: it is
either a form field beside the editor (the stack name) or something the parser
could not place. Red entries block deployment; orange ones are advisory and you
can deploy anyway.

### CPU and memory for a stack

In the compose editor, give each service a `deploy.resources` block — it is the
only place CPU and memory can be set for a compose service, and without one a
service gets a small default (100m CPU / 128Mi memory) that is not enough for a
real application:

```yaml
services:
  web:
    image: ghcr.io/acme/app:1.4
    deploy:
      resources:
        reservations:      # guaranteed to this service
          cpus: "0.1"
          memory: 128M
        limits:            # hard ceiling — exceeding memory restarts it
          cpus: "0.5"
          memory: 512M
```

`cpus` is in decimal cores (`"0.5"` is half a core). `memory` uses Docker's
units, so `512M` and `1G` mean 512 MiB and 1 GiB. If you give only `limits`,
the reservation matches them. The compose `cpus:` and `mem_limit:` fields from
older Compose versions are not accepted — the editor will point you here.

Your plan's quota is the ceiling for everything you run, so a stack asking for
more than it allows will be refused when it deploys.

Custom containers appear in the same table with a **Mode** column (Docker or
Compose) and an **Updates** column. Use the row's actions to upgrade the image
tag, **Preview** the running container without a route, **Stop**/**Start**, or
remove the container.

!!! tip "The Updates column"
    The **Updates** column checks the registry for you. For a version-numbered
    tag (`1.27.3`) it tells you when a newer **patch / minor / major** tag
    exists — click the pill to upgrade. For a moving tag (`latest`, `1.27`,
    `24.04`) it can't compare version numbers, so instead it watches whether the
    registry has **re-published that same tag** to a new image; when it has, the
    pill shows **update available** and clicking it re-pulls the current tag.
    **up to date** means the tag hasn't moved. **unknown** means the registry
    couldn't be checked (private image with no stored credentials, a rate limit,
    or the running image hasn't been observed yet) — hover the pill for the
    reason. The check runs when you open the tab and is cached for an hour; press
    **Check for updates** to re-check every container right now.

!!! warning "If a container keeps failing"
    When a container can't start — a bad image, a wrong command, or it runs out
    of memory — its status shows **failed** with the reason next to it (for
    example `CrashLoopBackOff — last exit 1`, `ImagePullBackOff`, or `OOMKilled`).
    `OOMKilled` means the container asked for more memory than its limit allows:
    raise the memory limit under **Assigned resources**, or find out why the app
    is using more than expected. A container that was killed outright now reports
    `OOMKilled` too, rather than the bare `Error` it used to show — the underlying
    kill looks identical, and memory is nearly always the cause.
    Kubernetes will keep restarting it. Click **Stop** to break the restart loop:
    it scales the container to zero but **keeps your configuration, storage and
    registry credentials**, so you can fix the image or command and then **Start**
    it again. (Your provider's administrators are also notified when one of your
    containers enters the failed state.)

!!! note "Don't see Custom Containers?"
    This is an optional, plan-gated feature. If the tab is missing or empty,
    your plan doesn't include custom containers — contact your provider if you
    need it.

## Environment & connection details

App settings (including connection details for databases your apps use) live in
the **Configuration** section of each deployment's **Details** panel, described
above. For working directly with database contents, use the
[SQL Manager](databases.md).

!!! info "What's not here"
    The tenant panel does **not** give you a shell/terminal into your running
    apps. To inspect what an app is doing, use its **Logs**; to work with files,
    use the [File Manager](files-and-sftp.md); to work with data, use the
    [SQL Manager](databases.md).
