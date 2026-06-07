---
verified: 2026.6.7
---

# Password-protect a folder

Sometimes you want part of a website locked behind a username and password — a
staging area, an admin folder, or private downloads. **Password-protected
directories** do exactly that: visitors to a protected path get a browser
sign-in box and can't see anything until they enter valid credentials.

!!! abstract "How it works for visitors"
    When someone opens a protected path, their browser shows a small **sign-in
    pop-up** (HTTP Basic Auth) asking for a username and password. Correct
    credentials let them through; the browser remembers them for the rest of the
    visit. No sign-in box appears on the rest of your site.

## Where to find it

Protection is set **per route** (per website address), under:

**Domains** → open a domain → **Ingress Routes** tab → click a route →
**Access Control** tab → **Password-Protected Directories**.

(See [Domains & websites](domains-and-websites.md#ingress-routes-connecting-a-domain-to-a-website)
for how routes work.)

## Protect a directory

1. Open the route's **Access Control** tab and expand
   **Password-Protected Directories**.
2. Click **Add Protected Directory**.
3. Fill in:
    - **Path** — the URL path to lock, starting with `/` (for example
      `/admin/`). No spaces.
    - **Realm Name** — the label shown in the browser's sign-in box (e.g.
      `Restricted`). Optional; defaults to `Restricted`.
4. Click **Create**.

The directory appears in the list showing its path, realm, number of users, and
whether it's **enabled**.

## Add users who can get in

A protected directory needs at least one user, or nobody can enter.

1. Click the directory to expand it.
2. In the **Users** section, click **Add User**.
3. Enter a **username** and **password** for that person.
4. Save.

Repeat to add more people. Each protected directory has its own separate list of
users.

## Manage a directory

Expanding a directory lets you:

- **Rename the realm** and **enable/disable** protection (then **Save**).
  Disabling temporarily removes the password prompt without deleting your users.
- **Add or remove users**, and enable/disable individual users.
- **Delete** the whole protected directory (trash icon) to remove protection
  entirely.

!!! tip "Use a clear realm name"
    The realm name is what visitors see in the sign-in box, so make it
    recognisable — for example "Acme Staging" rather than the default
    "Restricted".

!!! note "Works with any site"
    Protection is enforced before traffic reaches your application, so it works
    no matter what software runs behind that route.
