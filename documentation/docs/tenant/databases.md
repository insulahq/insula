---
verified: 2026.6.7
---

# Databases

A **database** is where an application stores its data — posts, products, users,
and so on. The **SQL Manager** (left menu) is a browser-based tool to create
databases, look inside tables, run queries, and move data in and out — no
desktop tools needed.

!!! abstract "How databases work here"
    First you **deploy a database engine** (MariaDB, PostgreSQL, MongoDB, Redis,
    or a SQLite file) from the catalog — see
    [Deployments & applications](deployments-and-applications.md). Then the SQL
    Manager connects to that running engine so you can manage the databases
    inside it. One engine can hold many databases.

## Pick a database to work with

1. Open **SQL Manager**.
2. At the top, choose the **deployment** (your database engine) from the
   selector. Only **running** engines can be selected.
3. In the left sidebar, pick the specific **Database** inside that engine.

For a SQLite-based app, the manager works directly on the SQLite file instead of
a server selector.

## Create a database and users

**Create a database**

In the sidebar next to the **Database** selector, click the **+** (Create
database) button, type a name, and click **Create**. To remove one, select it
and click the trash icon (this is permanent).

**Create a database user**

The sidebar also lists **Users** for the selected engine. To add one, enter a
username, pick which database it can access, and create it. A strong password is
generated and **shown once** — copy it immediately. You can also:

- **Regenerate password** for an existing user (also shown once).
- **Drop** a user to remove its access.

!!! warning "Save generated passwords right away"
    Generated database passwords are displayed a single time and can't be
    retrieved later. Copy and store them before closing the dialog. If you lose
    one, regenerate it (which changes the password).

## Browse, query, and edit data

With a database selected, the main area gives you:

- **Tables / Structure** (left sidebar) — click a table to **Browse** its rows,
  or view its **Structure** (columns and types). You can create and drop tables,
  and add or remove columns.
- **Browse** view — page through rows, sort by clicking a column, and edit
  individual rows.
- **Query (SQL)** view — type any SQL statement and run it. Results appear in a
  table below. This is the power-user tool; a typo in a `DELETE` or `DROP` can
  remove data, so be careful.

!!! tip "Not sure about SQL?"
    For everyday changes, use **Browse** to edit rows directly. Reach for the
    SQL console only when you know the statement you want to run.

## Import and export (dumps)

A **dump** is a single file containing a whole database — handy for backups or
moving a site between hosts.

**Export**

Click **Export**. The platform writes a dump file into your storage and tells
you the path; download it from the [File Manager](files-and-sftp.md).

**Import**

Use the **Import** menu to load a dump:

- **Direct upload** accepts a plain `.sql` file.
- For compressed archives (`.gz`, `.tar`, `.zip`), first upload the file in the
  [File Manager](files-and-sftp.md), then choose **Import from File** and pick
  it.

!!! warning "Imports overwrite"
    Importing a dump writes its contents into the selected database, replacing
    matching tables. Import into the right database — ideally export a backup
    first.

## Connection details for your apps

Apps you install from the catalog are wired to their database automatically — you
don't normally enter connection details by hand. When you do need them (for a
custom app), the host, name, user, and password live in the **Configuration**
section of the database deployment's **Details** panel — see
[Deployments & applications](deployments-and-applications.md#the-details-panel).
