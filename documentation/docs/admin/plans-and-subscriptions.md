---
verified: 2026.6.7
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
| **CPU Limit (cores)** | Max CPU the tenant's workloads may use. |
| **Memory Limit (GB)** | Max memory. |
| **Storage Limit (GB)** | Max persistent storage. |
| **Max Sub-Users** | How many additional logins the tenant may create. |
| **Max Mailboxes** | How many mailboxes the tenant may create. |
| **Weekly AI Budget (cents)** | The tenant's weekly spend cap for AI-assisted file editing (below). Shown live as a per-week currency figure. |
| **Description** | Optional free text. |

The currency that prices are shown in comes from
[Platform → Limits & Regional](platform-settings.md).

!!! note "Deprecating instead of deleting"
    A plan in `deprecated` status is greyed out in the list and won't be
    offered for new tenants, while existing tenants on it keep running.
    This is the safe way to retire a plan without disrupting current
    customers. You can also delete a plan outright with the trash icon
    (confirm required).

### The weekly AI-edit budget

The tenant panel includes an **AI-assisted file editor** (in the file
manager): a tenant can ask an AI model to rewrite a file. Each plan sets a
**weekly budget** that caps how much that costs per tenant. The models
themselves — and your provider API keys — are configured in
[Platform → AI Providers](platform-settings.md); the plan only sets the
spend cap. Set the budget to `0` to effectively disable AI editing for a
plan.

This is the only AI feature in the platform. There is no AI website
builder or AI page editor.

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
