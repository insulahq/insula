---
verified: 2026.7.2
---

# Plans & subscriptions

A **plan** is a reusable template of resource limits and a price. Every
tenant is assigned a plan; the plan decides how much CPU, memory, and
storage they get, how many sub-users and mailboxes they can create, and
how much monthly revenue they represent. A **subscription** is the
tenant's relationship to that plan over time — which plan, and when it
expires.

Billing in Insula is **manual-first**: there is no built-in payment
gateway and no automatic charging. You record the plan and expiry; you
collect payment however you already do (invoice, bank transfer, an
external processor). The platform's job is to track the numbers and warn
you before an expiry slips by.

## Managing plans

Open **Platform Settings → Hosting Plans**. The page lists every plan
with its price and limits at a glance. Click **Add Plan** to create one,
or the pencil icon on a row to edit it.

Each plan has these fields:

| Field | Meaning |
|-------|---------|
| **Code** | A short stable identifier (e.g. `starter`). Set once at creation; can't be changed later. |
| **Name** | The human label shown in dropdowns (e.g. *Starter*). |
| **Price (/mo)** | Monthly price in your platform currency. |
| **CPU Limit (cores)** | The old CPU reservation. Read only for tenants still on the pre-share model; ignored for everyone else. See below. |
| **CPU tier** | The *share* of the machine this plan sells — **Normal**, **High** or **Highest** (1× / 2× / 4×). Every application a tenant on this plan runs takes this share when applications compete for CPU; when the machine is quiet they all burst freely regardless. |
| **Burst ceiling (cores)** | The most any one of the tenant's containers may actually use. Reaching it throttles the container — it is never killed for it. Leave blank to derive it from **CPU Limit** as `max(1, limit × 2)`. |
| **Memory Limit (GB)** | Max memory. |
| **Storage Limit (GB)** | Max persistent storage. |
| **Max Sub-Users** | How many additional logins the tenant may create. **0** means none. |
| **Max Mailboxes** | How many mailboxes the tenant may create. **0** disables email for every tenant on the plan — see below. |
| **Bandwidth (GB/month)** | Monthly served-traffic allowance (default 100 GB). See [the monthly bandwidth cap](#the-monthly-bandwidth-cap) below. |
| **Description** | Optional free text. |

!!! warning "Setting Max Mailboxes to 0 switches email off for the whole plan"

    A plan with 0 mailboxes grants no email at all. Every tenant on it keeps
    the mailboxes they already have — the limit bounds new ones — but none can
    be created, and email cannot be enabled on a domain that does not already
    have it. The field warns you when you type 0, because the change reaches
    every tenant on the plan at once.

    The field is also **required**. Leaving it empty used to submit 0 silently,
    which is the same thing by accident.

The currency that prices are shown in comes from
[Platform → Limits & Regional](platform-settings.md).

Saved changes appear on the list straight away.

!!! warning "Changing CPU, memory or storage re-quotas live tenants immediately"
    Those three are not just defaults for future tenants. Saving them applies
    the new limits to **every tenant already on the plan**, there and then —
    so lowering one takes capacity away from running workloads, and a tenant
    already using more than the new figure will have deployments refused until
    they fit.

!!! note "The share and the ceiling are the exception — saving does not apply them"
    **CPU tier** and **Burst ceiling** are written when you save, but a
    tenant's namespace keeps enforcing what it has until someone presses
    **Apply new limits** for that tenant. Changing a ceiling replaces the
    tenant's applications, which should not happen as a side effect of
    editing a plan's price. Affected tenants show **change not applied**
    under *Cluster → CPU Scheduling*, with both figures side by side. See
    [CPU & capacity](../operator/cpu-and-capacity.md#changing-a-tenants-share-or-ceiling-afterwards).

!!! tip "The shipped plans"
    New installs ship Starter / Premium / Ultimate selling **Normal**,
    **High** and **Highest** with ceilings of **1**, **2** and **4** cores.
    An existing platform's plans are never rewritten by an upgrade — if
    yours predate the share model they will show no tier, and their ceiling
    is derived from **CPU Limit** until you set one.

    Tenants given an individual override on their **Resource Limits** card are
    not affected: the override wins, and a plan edit does not overwrite it.

    The other fields on this page — price, mailbox and sub-user counts,
    bandwidth — do not re-quota anything.

## The monthly bandwidth cap

Every plan carries a monthly bandwidth allowance, and each tenant can be given
an individual override on their **Resource Limits** card. The platform meters
each tenant's served traffic hourly and resets the counter on the 1st of the
month:

- At **80%** and **90%**, both the tenant and the admins get a notification.
- At **100%**, the tenant's sites switch to a friendly **"bandwidth limit
  reached"** maintenance page instead of serving traffic — a *soft* cap: no
  data is touched, mail keeps flowing, and the panel stays reachable.
- Serving resumes automatically at the month rollover, or immediately when you
  raise the tenant's limit.

### What the meter counts

**Traffic that left the cluster.** Nothing else.

That sounds obvious and was not what happened. The meter used to sum every
byte a tenant's pods transmitted, which includes the database answering the
application inside the namespace — over a path that never touches the
network. Measured over six hours on a reference production cluster, tenants
were billed **4,687 MB against 668 MB actually served**: 7.0× overall, 190×
for the most database-heavy tenant, and 1.0× for every tenant with no
database add-on. That last figure is the one that identifies the excess: it
was intra-namespace chatter, not egress.

Two things are counted now:

- **What the ingress served**, measured by Traefik per tenant. This is
  exact, and it is the number a tenant can reconcile against their own
  route page.
- **An estimate of the egress the ingress cannot see** — an outbound API
  call, SMTP, a package pull. It is derived from what the pods sent and
  received rather than guessed, and it is bounded on both sides by things
  that are measured: never below what Traefik counted leaving, never above
  what the pods actually transmitted.

Backups the platform schedules are excluded, as before: a tenant's backup
Job runs inside their namespace and ships off-site, and billing a tenant for
a backup they did not ask for is not defensible — on the same cluster it was
once **78%** and **80%** of the two busiest tenants' recorded egress. Only a
backup a tenant starts themselves counts.

Inbound is not billed. Restores are inbound, and so is the request half of
ordinary web traffic; the tenant's chart shows both directions while the
allowance counts only what left.

!!! note "Not applied retroactively"
    The meter is forward-looking. A cycle already in progress when this
    changed keeps whatever it had accumulated until the month rolls over.

!!! note "Deprecating instead of deleting"
    A plan in `deprecated` status is greyed out in the list and won't be
    offered for new tenants, while existing tenants on it keep running.
    This is the safe way to retire a plan without disrupting current
    customers. You can also delete a plan outright with the trash icon
    (confirm required).

## Subscriptions and expiry

Each tenant's subscription lives in the **Subscription** card on the
[tenant detail page](tenants.md). It shows three things: the assigned
**Plan**, a **Status** badge, and the **Expires** date. Click **Edit** to:

- **Change the plan** — pick a different plan from the dropdown (each
  option shows its monthly price).
- **Set or clear the expiry date** — a simple date field. Leave it blank
  for "no expiry" (e.g. an internal or perpetual account).

Changing the plan here is the subscription-level equivalent of changing
limits; if you only want to bend one limit for one tenant, use the
[per-tenant overrides](tenants.md) on the Resource Limits card instead.

**Email the tenant about this change** is ticked by default — changing
someone's plan or renewal date is normally something they should hear about.
Untick it when the edit does not concern them: correcting a date you mistyped,
or recording a renewal that was already agreed by phone. The choice applies
only to the edit you are saving; the box is ticked again next time you open
the form, so a silent edit cannot make the following one silent by accident.

## Expiry notifications

Because billing is manual, the platform's safety net is **admin-facing
expiry reminders**. As a subscription's expiry date approaches, the
platform raises notifications so you can collect payment and renew (or
decide to suspend the account) before it lapses. These reminders go to
**you, the admin** — never to the customer directly — so you stay in
control of customer communication.

Where those reminders are delivered (in-app, email, and which channels)
is configured in [Platform → Notifications](platform-settings.md), under
the relevant notification *Source*.

!!! tip "The 7-day Dashboard signal"
    A subscription nearing expiry surfaces on the
    [Dashboard](index.md) and in the notifications bell, so you don't have
    to remember to check. Renew by editing the Subscription card's expiry
    date.

## External billing posture

To be explicit about what Insula does **not** do:

- It does **not** charge cards or process payments.
- It does **not** integrate a payment gateway out of the box.
- It does **not** auto-suspend on non-payment — suspension is an action
  *you* take (manually or in bulk) from the [Tenants](tenants.md) page.

The plan price is a record-keeping figure that drives the expiry
reminders and your own revenue tracking. Connect it to whatever invoicing
or payment process your business already runs.
