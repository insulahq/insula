---
verified: 2026.6.7
---

# Welcome to your hosting account

This is your control panel — the **Tenant Portal**. It is where you run your
websites, email, databases, files, and backups, all from a web browser. No
software to install, nothing to keep up to date on your side.

You do not need to know anything about servers to use it. Each section of this
guide starts with the *idea* behind a feature, then gives you short
step-by-step recipes using the exact buttons you will see on screen.

!!! tip "Who runs the platform?"
    Your hosting provider owns and operates the servers behind this panel. If
    something is missing, broken, or you need a plan change, **contact your
    provider's support** — see [Where to get help](#where-to-get-help) at the
    bottom of this page.

## Signing in

Open the portal address your provider gave you. You will see the **Tenant
Portal** sign-in card. Depending on how your provider set things up, you may
see one or more of these options:

=== "Email + password"

    Enter your **Email** and **Password**, then click **Sign In**. This is the
    most common way in.

=== "Passkey"

    A passkey lets you sign in with your device's fingerprint, face, or PIN
    instead of typing a password. If passkeys are available you will see a
    **Sign in with passkey** button.

    Passkeys are more secure than passwords and can't be phished. You set one
    up later under [Account & security](account-and-security.md).

=== "Single sign-on (SSO)"

    If your provider uses a company login, you will see a **Sign in with…**
    button. Click it and you will be sent to that login screen, then returned
    here automatically.

If your account uses **password + passkey**, you will be asked to confirm with
your passkey right after entering your password. That second step is your
two-factor protection.

??? info "Forgot your password?"
    There is no self-service password reset in the portal. Ask your provider's
    support to reset it for you.

## A quick tour of the dashboard

After signing in you land on the **Dashboard** — a one-glance summary of your
account.

| What you see | What it means |
|---|---|
| **Welcome back, …** | Your name (or email). |
| **Quick stats** row | Counts of your Domains, Applications, Backups, Deployments, and Email accounts. Click any card to jump straight there. |
| **Subscription** card | Your current plan and its limits (CPU, memory, storage). Click to open Settings. |
| **Deployed Applications** card | Your running websites and apps with a status dot. |
| **Resource Usage** card | Live bars showing how much CPU, memory, and storage you are using against your plan. |
| **Notifications** card | Your latest account messages. |

If your account is ever **suspended** or a maintenance task is running, an
**Account state** box appears at the top of the dashboard so you always know
the current status.

The bar across the **top** of every page has a search box, live
CPU/memory/storage chips, a bell for notifications, a light/dark theme toggle,
and your **user menu** (top-right circle) for quick access to settings,
changing your password, and signing out.

The **menu on the left** is how you move around. Here is what each item is for:

| Menu item | What you do there | Guide |
|---|---|---|
| **Dashboard** | The overview above. | — |
| **Domains** | Add domains, manage DNS and certificates, set up websites. | [Domains & websites](domains-and-websites.md) |
| **Applications** | Install apps and runtimes, run custom containers. | [Deployments & applications](deployments-and-applications.md) |
| **SQL Manager** | Create databases, browse tables, run SQL, import/export. | [Databases](databases.md) |
| **Scheduled Tasks** | Run recurring jobs on a schedule. | [Cron jobs](cron-jobs.md) |
| **File Manager** | Browse, upload, and edit your website files. | [Files & SFTP](files-and-sftp.md) |
| **Email** | Mailboxes, aliases, webmail, mail-client setup. | [Email](email.md) |
| **Backups** | Run and restore backups. | [Backups & restore](backups-and-restore.md) |
| **Users** | Invite teammates and set what they can do. | [Account & security](account-and-security.md) |
| **SSH Keys** | Store public keys for secure file access. | [Files & SFTP](files-and-sftp.md) |
| **SFTP Access** | File-transfer accounts for uploading. | [Files & SFTP](files-and-sftp.md) |
| **Private Workers** | Advanced background workers (if your plan includes them). | — |
| **Resource Usage** | Detailed CPU/memory/storage charts. | — |
| **Notifications** | Your full message history and preferences. | [Account & security](account-and-security.md) |
| **Settings** | Subscription details and account-wide settings. | [Account & security](account-and-security.md) |

!!! note "Some pages may be hidden or read-only"
    Your provider and your plan decide which features you get. If you don't see
    a menu item, or a button is greyed out with a "read-only" note, that
    feature isn't enabled for your account or your role. That's normal.

## What you can do here

In plain terms, this portal lets you:

- **Put a website online** — point a domain at the platform, get a free HTTPS
  certificate, and install an app or upload your own files.
- **Run real applications** — WordPress, Node.js, PHP, static sites, databases,
  and more from a catalog, or bring your own container.
- **Send and receive email** — create mailboxes on your domains, read them in
  webmail or your phone, and set up forwarding.
- **Keep your data safe** — automatic backups you can restore from, file by
  file if needed.
- **Work as a team** — invite colleagues and control what each one can touch.

Each of those has its own page in this guide. Start with whatever you need
first — there's no required order.

## Where to get help

This panel is operated by **your hosting provider**, not by the software
authors. For anything you can't do yourself — plan upgrades, billing,
suspended accounts, password resets, or a feature that isn't working — use the
**support contact your provider gave you** (their website, helpdesk, or email).

Notifications about your account (renewals, backups, security events) appear
under **Notifications** in the left menu and, if enabled, by email.
