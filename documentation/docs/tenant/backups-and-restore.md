---
verified: 2026.6.7
---

# Backups & restore

Backups are your safety net. The platform captures your account into a
**bundle** — a single saved snapshot of your files, mailboxes, databases,
domains, and apps — that you can restore from later if something goes wrong.
Open **Backups** from the left menu.

!!! abstract "What a bundle contains"
    Each bundle is a point-in-time copy of your account: website files,
    mailboxes, databases, domain settings, and deployments. When you restore,
    you choose exactly which pieces to bring back.

## What's backed up, and when

Scheduled backups run **automatically on a platform-wide schedule** set by your
provider — you don't configure the timing yourself. Whether your account is
included, and how long bundles are kept, depend on your plan.

The **Backups** page lists your bundles with their **status** (completed,
running, partial, failed, expired), **size**, **created** date, and **expires**
date. The page note reminds you that scheduling is managed centrally by your
admins.

## Run a backup on demand

Want a fresh snapshot right now — say, before a risky change?

1. Click **Run backup now** (top right).
2. A progress window opens and tracks the new bundle as it builds.

The finished bundle appears in the list, ready to restore from.

## Restore from a bundle (the restore cart)

Restoring works like an online shopping cart: you browse a bundle, add the
exact items you want back to a cart, then run the restore.

1. On the **Backups** page, find a **completed** (or partial) bundle and click
   **Restore**.
2. The **Restore** page opens for that bundle. Browse it using the tabs on the
   left and **add** items to the cart on the right:

    | Tab | What you can restore |
    |---|---|
    | **Tables** | Specific account configuration tables. |
    | **Deployments** | One or more apps. |
    | **Domains** | Domain and routing settings. |
    | **Mailboxes** | Individual email accounts, by address. |
    | **Files** | Files and folders from your storage. |

3. When the cart has what you need, click **Execute cart**.
4. Items restore one at a time. If one fails, the cart pauses so you can review
   and retry — it won't silently skip ahead.

!!! tip "Restore only what you need"
    You don't have to restore the whole account. If you only deleted one
    mailbox or one folder, add just that to the cart and leave everything else
    untouched.

!!! warning "Restoring overwrites current data"
    Restoring replaces the live version of whatever you restore with the copy
    from the bundle. Make sure you're restoring the right items from the right
    bundle. Undoing a restore (rollback) needs your provider's help — it isn't
    available in the tenant panel.

### Recent restore carts

The page shows your **Recent restore carts** with their status (done, executing,
failed) so you can see what you've restored lately.

## GDPR / data export

When a completed bundle includes a data export, a **GDPR** download button
(with a lock icon) appears in its row on the **Backups** page. Click it to
download an **encrypted** export of the bundle's personal data — useful for
data-portability or compliance requests.
