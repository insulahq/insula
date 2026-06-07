---
verified: 2026.6.7
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
| **Rename / Delete** | Per-file actions. |
| **Copy / Move** | Select items → **Copy** or **Move** in the bulk toolbar. |
| **Archive (zip/tar)** | Select items → **Archive**. Extract an archive from its row action. |
| **Permissions / Ownership** | Select items → **Permissions** or **Ownership** (advanced — change file access modes). |

The **Import** menu offers three handy shortcuts:

- **From URL** — download a file straight from a web address into the current
  folder.
- **Clone Website** — copy an existing website into your storage.
- **Git Clone** — pull a Git repository into a folder.

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
accounts support **SFTP, SCP, rsync, and FTPS**.

### Connection details

The **SFTP Access** page shows a **Connection Details** box with the **Host**,
**Port**, FTPS port, and supported **Protocols** — each with a copy button.
Expand **Usage Examples** for ready-to-paste command lines for every protocol,
using either password or SSH-key authentication.

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
