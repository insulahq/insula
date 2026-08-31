---
verified: 2026.7.2
---

# Files & SFTP

Your websites' files live in your account's storage. You can work with them two
ways: the **File Manager** in your browser, or a **file-transfer (SFTP)
account** for desktop tools. This page also covers **SSH keys**, which make
file transfer more secure.

## File Manager

Open **File Manager** from the left menu. It works like the file explorer on
your computer: a path breadcrumb at the top, folders and files in the middle,
and an actions toolbar.

### Browse and select

- Click a folder to open it; use the breadcrumb (or the home icon) to go back up.
- Tick the checkboxes to select multiple items and reveal a bulk-action toolbar.

### Everyday actions

| Action | How |
|---|---|
| **Upload** | Click **Upload** (or drag files onto the window). |
| **New File** / **New Folder** | Buttons in the toolbar. |
| **Download** | Per-file action. |
| **Rename / Move to Trash** | Per-file actions. Deleted files go to the [recycle bin](#recycle-bin) unless you tick **Delete permanently**. |
| **Delete many** | Select items (or **Select all**) → **Move to Trash** in the bulk toolbar. The whole selection is handled in a single operation, and if any item cannot be removed you are told which ones — the rest still go. |
| **Copy / Move** | Select items → **Copy** or **Move** in the bulk toolbar. |
| **Archive (zip/tar)** | Select items → **Archive**. Extract an archive from its row action. See [Large archives](#large-archives). |
| **Permissions / Ownership** | Select items → **Permissions** or **Ownership** (advanced — change file access modes). |

The **Import** menu offers three handy shortcuts:

- **From URL** — download a file straight from a web address into the current
  folder.
- **Clone Website** — copy an existing website into your storage.
- **Git Clone** — pull a Git repository into a folder.

### Recycle bin

Deleting a file or folder in the file manager **moves it to a recycle bin**
rather than erasing it. You can put it back later from the same place you
deleted it.

!!! warning "The recycle bin is not free space"

    Trashed items stay on your storage and keep counting against your quota
    until they expire or you empty the bin. **Deleting files does not free
    space on its own.** If you are trying to make room, either empty the bin
    afterwards or tick **Delete permanently** when you delete.

**Opening it.** When the bin holds anything, an *"… in bin"* button appears
next to the storage figure at the top of the Files page. Click it to see
everything you have deleted, how much space each item uses, and how many days
are left before it is removed for good.

**Restoring.** Press **Restore** on any row. The file goes back to the exact
folder it came from, and missing parent folders are recreated for you. If
something new already occupies that path you are asked whether to **restore
alongside** it (the recovered copy is renamed) or **replace** what is there
now — nothing is overwritten without you choosing it.

**Removing things for good.** Use **Delete** on a single row, or **Empty
recycle bin** to clear everything. Both free the space immediately and cannot
be undone.

**Automatic clean-up.** Items are removed automatically after a set number of
days — 14 by default. Your provider sets this window; the exact number is
shown in the bin and in the delete dialog.

**Undo.** Right after a delete, a bar appears at the top of the page offering
**Undo**. That is the quickest route back — you do not have to open the bin and
find the file. It restores *alongside* anything that has taken the path in the
meantime, so nothing is overwritten.

**Working in bulk.** Tick the checkbox on any row (or the one in the header to
select everything shown) to **Restore selected** or **Delete selected** in one
action, and use the filter box to narrow a long list by name or original
location.

### Replaced files are kept too

The bin does not only catch deletions. When an operation *replaces* an existing
file, the previous version goes to the bin as well, labelled with what replaced
it:

| Doing this… | …to a name that already exists |
|---|---|
| **Move / rename** | the file that was there is kept |
| **Copy** | the overwritten destination is kept |
| **Upload** | the previous upload is kept |
| **Extract an archive** | every file the archive overwrites is kept |
| **New File** | the existing file is kept |

So re-extracting an application archive over a live site no longer destroys
your customisations — the previous versions are all recoverable.

The one deliberate exception is **saving in the editor**. That is you
overwriting a file you have open on purpose, so it does not create a bin entry;
otherwise every save would fill the bin and bury the accidents it exists to
catch.

**What the bin does *not* cover.** It protects work done **in the file
manager**. Files removed or replaced over SFTP, or by your own application
code, are gone immediately — there is no copy to restore.

Deleting an application with **Also remove data folder** ticked sends that
folder to the bin too, so the files remain recoverable. Restoring returns the
*files* only — it does not bring the application back.

### Large archives

There is no size or file-count limit on extracting or creating an archive. A
CMS or framework release containing tens of thousands of files extracts the
same way a handful of files does — it simply takes longer.

While it runs you see live progress rather than a spinner:

- **Zip files** show a real percentage and a running count (`4,182 / 14,191`),
  along with the file currently being written. The total is read from the
  archive itself before extraction starts.
- **Tar archives** (`.tar`, `.tar.gz`, `.tgz`) and **archive creation** show a
  running file count with no percentage. A tar file carries no index of its
  contents, so the total genuinely is not known until the work finishes — the
  count is shown instead of a made-up percentage.

Keep the dialog open until it completes. If something goes wrong the message
names the cause — a damaged archive, not enough free space, or a tool that
stopped responding — rather than a generic failure.

!!! note "Where an archive extracts to"
    Extraction preserves the folder structure **inside** the archive. Many
    downloads wrap everything in a single top-level folder, so extracting into
    `/public` can produce `/public/product-name/…` rather than files directly in
    `/public`. Check the destination afterwards and move the contents up a level
    if your site expects them at the root.

### When an action fails

If an operation cannot complete, a red banner appears at the top of the File
Manager explaining why. It stays until you dismiss it, so a failure can no
longer pass unnoticed while a dialog sits open.

One cause is worth recognising, because nothing is wrong with your file: the
platform's web firewall inspects requests for attack patterns, and a few
ordinary web filenames — `.htaccess`, `web.config` and similar — look like the
patterns it watches for. If the banner says the request was blocked by the
firewall, the file is fine and nothing you change about it will help. Ask your
provider to review the event under Security → WAF Events.

### Edit files in the browser

Click a text file to open the built-in **editor** (syntax-highlighted). Make
your changes and **Save**.

### AI-assisted editing

If your provider has enabled AI editing, you can ask the assistant to make
changes for you instead of editing by hand:

=== "Inside the editor"

    Open a file in the editor and use the **AI** panel: type what you want in
    plain language (for example "add a contact form section"), pick a model if
    asked, and the assistant proposes a change. Review the highlighted
    difference and click **Accept** to apply it (or discard it).

=== "Across a folder (Sparkles button)"

    The **AI Edit (folder)** button (sparkles icon) in the toolbar lets the
    assistant work across multiple files in the current folder.

!!! note "AI editing is optional"
    The AI features only appear when your provider has configured them. If you
    don't see them, they're not enabled for your account. This is *file
    editing assistance* — there is no separate "AI website builder."

## File-transfer (SFTP) accounts

To upload with a desktop tool (FileZilla, Cyberduck, WinSCP) or automate
transfers, create a **file-transfer account** under **SFTP Access**. These
accounts support **SFTP, SCP, and rsync** — all over one SSH connection.

### Connection details

The **SFTP Access** page shows a **Connection Details** box with the **Host**,
**Port**, and supported **Protocols** — each with a copy button. On a standard
install the host is **`files.<your provider's domain>`** on port **23022**
(the platform runs the gateway on every server node, so the hostname keeps
working through node changes). Expand **Usage Examples** for ready-to-paste
command lines for every protocol, using either password or SSH-key
authentication.

!!! note "No FTP/FTPS"
    The gateway deliberately speaks only SSH-based protocols. Plain FTP and
    FTPS are not offered — SFTP/SCP/rsync cover the same use cases with
    stronger authentication and none of FTP's firewall pain. Any modern
    client (FileZilla included) supports SFTP out of the box.

### Create a file-transfer user

1. On **SFTP Access**, click **Add User**.
2. Enter a **Description** (e.g. "CI/CD deployment").
3. Choose an **Authentication Method**:
    - **Password (auto-generated)** — a username and strong password are created
      for you. The password is shown **once** — copy it now.
    - **SSH Key** — a username is created and access uses the SSH keys you
      select (you must add keys first, see below). Works with SFTP, SCP, and
      rsync.
4. Click **Create User**.

Each user can later be edited to change its description, enable/disable it, or
switch authentication method. A **Recent Activity** panel shows recent
connections and any failed sign-ins.

!!! warning "Passwords are shown once"
    Auto-generated SFTP passwords appear a single time at creation. Copy and
    store them immediately. If lost, edit the user and re-save with password
    auth to generate a new one.

## SSH keys

An **SSH key** is a pair: a *public* key you share with the platform, and a
*private* key that stays on your computer. Together they let you connect
securely without typing a password.

On the **SSH Keys** page, click to add a key, give it a **name**, and paste your
**public key**. You can edit or delete keys later. Once added, a key can be
selected when creating an SSH-key-based [SFTP user](#create-a-file-transfer-user).

!!! danger "Never paste your private key"
    Only ever add your **public** key here. Your private key must stay on your
    own machine and should never be shared with anyone, including the platform.
