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
permanently deleting you can also choose to delete its data folder.

## Custom containers (bring your own)

If your plan allows it, the **Custom Containers** tab lets you run your own
container images instead of catalog apps. Two ways:

=== "Single container (New Container)"

    Click **New Container** and follow the wizard to run one image (for example
    `nginx:1.27.5`). Good for a single service.

=== "Multi-service stack (New Stack)"

    Click **New Stack (compose)** to define several services together using a
    Docker-Compose-style editor. Good for an app plus its database, cache, etc.

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
