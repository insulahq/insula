---
verified: 2026.9.35
---

# CPU & capacity

Kubernetes places work by what a pod **reserves**, not by what it uses. That one
sentence explains most capacity surprises on a small cluster, and it is the
reason this page exists.

When you give a tenant "2 cores", the platform writes that as a *request*. The
scheduler then treats those 2 cores as spoken for on whichever node the pod
lands, whether or not a single one of them is ever burned. Reserve enough of
them and the cluster runs out of room on paper while the machine itself sits
nearly idle — and the failure you see is not "CPU is busy", it is a pod that
will not start.

## The symptom

The messages that mean this are rarely about CPU:

- *"No platform node has enough resources to schedule the pod."*
- A memory-shaped complaint about a tenant that is using a fraction of its
  memory allowance.
- An application that restarts occasionally for no reason you can find, most
  often when a routine maintenance job runs.

The last one is the giveaway. If a node has no room left to *reserve*, a pod
that outranks a tenant's application can take its place, and the application is
evicted and rescheduled. Nothing was overloaded; the books were just full.

## Cluster → CPU Scheduling

**Cluster → CPU Scheduling** puts the two numbers next to each other:

| Figure | Meaning |
|---|---|
| **Reserved** | Share of allocatable CPU that pods have *requested* |
| **Actually used** | Share the cluster is really burning |
| **Would be freed** | Cores the tier model would give back |
| **Need review** | Tenants that cannot be migrated automatically |

A cluster where *Reserved* is high and *Actually used* is low is oversubscribed
on paper only. That gap is the thing to act on — it is what turns a routine job
into an eviction.

!!! note "A node that does not report usage is not a node at 0%"
    If usage cannot be read from every node, *Actually used* shows **not
    reported by every node** rather than a percentage. A zero there would read
    as a perfectly idle cluster and exaggerate the gap.

Below the summary, one row per tenant shows what it reserves now, what it would
reserve under the tier model, its burst ceiling, and its observed peak (p95).
Expand a row to see the individual applications.

### Migrating a tenant

Each tenant row carries its own **Migrate this tenant** button, inside the
expanded row. There is no "migrate everything" control, and none is planned:
migration recreates pods, and doing that across a whole cluster from one click
is precisely the flag day this design avoids.

What happens when you press it:

1. A CPU **LimitRange** is created for the tenant's namespace, so every
   container gets a share and a ceiling from then on.
2. Each application is re-tiered **one at a time**, biggest saving first,
   waiting for the cluster to settle between each. Biggest-first is
   deliberate — every migration hands CPU back, so the earliest steps buy the
   headroom that makes the later ones safe.
3. The namespace's CPU reservation budget is resized to what the tenant's
   applications now actually ask for, plus room to roll one of them.
4. Only then is the tenant marked as tiered.

While it runs you get a **Stop after this step** button. It is not a cancel:
the run finishes the step it is on and puts the tools down between steps, so
the tenant is never left half-way through a single change.

!!! warning "Migrating restarts the tenant's applications"
    Every re-tiered application is **rolled**: Kubernetes starts the new pod
    before retiring the old one, so a healthy app stays reachable throughout.
    Two things are worth knowing anyway:

    - An app that cannot be re-tiered cleanly but still has to pick up the new
      ceiling — most often one already sized exactly at a tier value — is
      rolled the same way, so it too stays up.
    - A pod that the platform cannot match to any application (for example a
      deployment marked stopped in the database whose pod is still running) is
      **deleted** so its replacement inherits the ceiling. Whatever owns it
      recreates it, but a single-replica workload is briefly unavailable.

    Migrate one tenant at a time and watch it, which is what the per-tenant
    button is for.

!!! tip "Stopping part-way is safe"
    A stopped or failed migration leaves the tenant on the **old** model with
    some applications already re-tiered. That state is stable and serviceable
    — a smaller CPU request is always easier to schedule than the one it
    replaced — so a tenant that stops half-way is better off than before it
    started, not worse.

### Reverting

A migrated tenant shows **Revert to legacy** instead. The revert restores each
application's **exact** prior CPU request, recorded before anything was
changed — not a recalculated equivalent. It removes the burst ceiling first
(so a restore cannot be refused by a limit the migration itself installed) and
the LimitRange last.

If a baseline cannot be honoured for some application, the revert says so and
counts it, rather than putting back a number nobody chose.

### What the dry run decides for you, and what it does not

The report auto-classifies. Only these need a human:

| Reason | What to do |
|---|---|
| An application **pins its own CPU** (a custom container with explicit resources) | Decide deliberately; the platform will not overwrite a value you set by hand |
| A **compose stack** | Its CPU request covers several services with no unambiguous way to split it back |
| **No usage samples** in the last 7 days | Let it run, or size it yourself — there is nothing to size against |

A tenant whose reservation would *increase* is shown as an increase, not
folded into the total as if it were a saving.

### Where to find it

**Cluster → CPU Scheduling**, always — not only when the cluster is already in
trouble. The dashboard raises a finding only when a node is reserved-full *and*
idle, because that is the right rule for an alarm. Discovery is a different job:
a cluster at 40% reserved should be able to look at this before it becomes the
cluster at 96%.

### What bounds a tenant, and what deliberately does not

One thing bounds a tenant's CPU: the **per-container ceiling**. Kubernetes
applies it to every container that starts without a CPU limit of its own,
which under the share model is every application a tenant deploys.

There is deliberately **no namespace-wide CPU ceiling** — no cap on the sum
of a tenant's ceilings, and none on how many applications they may run.
An earlier version of this had both, and both were mistakes worth naming:

- A quota that bounds the *sum* of ceilings is really a cap on the number of
  containers, because a quota charges each container its whole ceiling the
  moment it starts, idle or not. A tenant hit it by deploying an ordinary
  third application, and then could not restart anything either — replacing
  a pod needs room beside the one it replaces.
- A `max` on the namespace applies to **every** container in it, and a
  tenant namespace is not only the tenant's: the platform runs its own jobs
  there, including the file backup. One sized to the tenant's ceiling
  refused the backup job outright.

So a tenant running five applications can, in principle, burst to five times
their ceiling if the node happens to be idle. That is the model working:
idle capacity is there to be used, the *share* is what decides who gets the
CPU when it is contended, and nothing was bounded at all before the share
model existed.

!!! note "Memory is the constraint that stops a tenant adding applications"
    Memory is reserved, incompressible, and quota-bounded per plan. If a
    tenant cannot deploy another application, look at memory first — CPU no
    longer refuses anything at the namespace level.


### Changing a tenant's share or ceiling afterwards

A migrated tenant's share and ceiling can be edited at any time — on the
tenant's own page, or through its plan. **Saving the change does not apply
it.** The tenant's namespace keeps enforcing what it has until you press
**Apply new limits**, which appears on the tenant detail page and as
**Apply pending change** in the tenant's row here.

That separation is deliberate. Changing a ceiling replaces the tenant's
applications, and that should not happen as a side effect of saving a form
that also edits memory and mailbox counts.

Both places tell you which of the two you are about to do:

| What you changed | What applying does |
|---|---|
| The **share** only | Replaces nothing. The share governs how CPU is divided under contention; existing applications pick it up without restarting. |
| The **ceiling** | Replaces the tenant's applications, one at a time with a health check between — the same pacing a migration uses. A ceiling is stamped onto a container when it starts, so a running application cannot pick up a new one. |

Until you apply it, the tenant's row shows **change not applied** with both
figures side by side — what is saved, and what the namespace is really
enforcing. Tenants are shown the enforced figure, never the saved one, so
they are never told they may burst further than they can.

!!! note "A tenant with measured load above the new ceiling still needs review"
    The same acknowledgement that guards a first migration guards a
    re-apply, for the same reason: lowering a ceiling under a tenant whose
    peak already exceeds it migrates them straight into throttling.

## New clusters start on the share model

A cluster installed from this release onwards creates its tenants on the
share model from the start — there is nothing to migrate, and the pages
above will simply show every tenant as tiered.

**An existing cluster is never switched.** The choice is made once, at the
first tenant creation after upgrading, and recorded: a platform that
already has tenants stays on the old model and nothing moves until you
migrate it, tenant by tenant.

While any tenant is still on the old model, the operator console carries a
standing note with that cluster's own reserved-versus-used figures, how
many cores migrating the rest would hand back, and a link to this page. It
disappears by itself once the last tenant is migrated; there is nothing to
dismiss, because the cost it names is real for as long as it is there.

## Quotas and the headroom advisory

When you save a tenant's CPU or memory quota, the platform adds up what every
tenant is *allowed* to consume and compares it against what the cluster can
carry. What "can carry" means depends on the cluster:

- **More than one server** — the budget holds one server's worth in reserve, so
  that losing any single node still leaves somewhere for its work to go.
- **A single server** — there is nowhere to fail over to, so that reserve is
  meaningless. The budget is simply what the machine has, less the platform's
  own share.

!!! note "This is advice, not a gate — the save always goes through"
    Oversubscription is a legitimate position on this platform: a CPU request
    reserves a place in the queue, it does not cap anything, so selling more
    than the machine has is a deliberate trade rather than a fault. The check
    therefore **reports** and never refuses. The verdict is written to the
    audit log (`resource_quota.update.over_headroom`) and returned with the
    saved quota as `headroomAdvisory`.

It sums **ceilings**, not current usage — the worst case where every tenant
uses everything its plan permits at once. That total can sit well above what
the cluster is actually running, which is the point: it is the number that
tells you how exposed you would be if everyone showed up at the same time.

To see where the slack is, use **CPU Scheduling** above.

## Background

The reasoning behind treating CPU as a share rather than a reservation is
recorded in **ADR-062** in the project repository.
