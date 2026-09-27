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

### This page changes nothing

It is a **dry run**. It shows what *would* happen; there is no apply button. Use
it to understand the cluster and to see which tenants need attention before any
model change is rolled out.

The **Verdict** column is either *migrates cleanly* or *needs review*. Expand a
tenant marked for review to see why — the reason is always named, and so is the
application it applies to:

| Reason | What to do |
|---|---|
| An application **pins its own CPU** (a custom container image with explicit resources) | Decide deliberately; the platform will not overwrite a value you set by hand |
| **No usage samples** in the last 7 days | Let it run, or size it yourself — there is nothing to size against |

A tenant whose reservation would *increase* is shown as an increase, not folded
into the total as if it were a saving.

### Where to find it

**Cluster → CPU Scheduling**, always — not only when the cluster is already in
trouble. The dashboard raises a finding only when a node is reserved-full *and*
idle, because that is the right rule for an alarm. Discovery is a different job:
a cluster at 40% reserved should be able to look at this before it becomes the
cluster at 96%.

## Quotas and the headroom check

When you save a tenant's CPU or memory quota, the platform checks the new total
against what the cluster can carry and refuses a quota it cannot honour. What
"can carry" means depends on the cluster:

- **More than one server** — the budget holds one server's worth in reserve, so
  that losing any single node still leaves somewhere for its work to go.
- **A single server** — there is nowhere to fail over to, so that reserve is
  meaningless. The budget is simply what the machine has, less the platform's
  own share.

The refusal message says which of the two it is enforcing, and by how much the
request exceeds it.

Only a change that makes things **worse** is refused, and only in the
dimension that grows. Lowering a quota, or re-saving the same values, always
passes — including on a cluster that is already oversubscribed. Otherwise the
check would forbid the very thing its own error message asks you to do.

!!! warning "Already oversubscribed?"
    On a cluster whose tenant ceilings already add up to more than the budget,
    every *increase* is refused until the total comes down; nothing is shrunk
    retroactively. Use **CPU Scheduling** to find the reserved-but-unused
    capacity before raising anyone's allowance. A `super_admin` can override a
    single refusal deliberately when they are accepting the risk knowingly.

## Background

The reasoning behind treating CPU as a share rather than a reservation is
recorded in **ADR-062** in the project repository.
