---
verified: 2026.6.7
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

## Find an installed app

The **Installed Apps** tab has a search box and a grid/list switch in its
toolbar.

- **Search** matches the deployment name, the application it was installed
  from, its type and its status — so `postgres`, `failed` or `database` all
  find what you would expect, not just an exact name. The counter next to the
  box shows how many of your deployments match.
- **Grid** (the default) shows each deployment as a card with live CPU, memory
  and storage. **List** shows a compact sortable table — name, application,
  type, status — with the same actions; click any column heading to sort by it.
  Whichever you pick is remembered the next time you open the tab.

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
  within your plan limits).
- **Logs** — click **Logs** to see recent output. It shows a snapshot by
  default; toggle **Stream Live** to watch new lines as they arrive. This is
  the first place to look when an app misbehaves.

### Updating an app

When a newer version is available, the card shows an **Update available** badge.
Open **Details** to review and apply the upgrade.

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

The token is checked against the registry as part of validation, so a wrong or
expired token is reported while you are still in the form rather than showing
up later as `ImagePullBackOff`. It is only ever sent to the registry host you
named — a stack mixing a private registry with public images (`redis:7`, say)
never offers your token to the public one.

To rotate or remove a credential later, use the registry-key button on the
container's row. In a compose stack the credential covers the whole stack; if
your services pull from more than one private registry, add the extra
credential from that button after the stack is created.

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
