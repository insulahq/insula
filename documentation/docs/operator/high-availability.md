---
verified: 2026.6.7
---

# High availability

A single-node Insula install is simple and cheap, but any node failure is an
outage. **HA mode** takes you from "any node failure causes downtime" to "any
single server can fail without downtime" — and it is a single, reversible
button.

You do not assemble HA piece by piece. When the cluster is ready, the admin
panel offers **Apply HA**, and one action scales everything that matters.

## What Apply HA changes

| Component | Local (default) | HA |
|---|---|---|
| Longhorn volumes (Postgres + mail) | 1 replica | 3 replicas, spread across nodes |
| PostgreSQL (CNPG cluster) | 1 instance | 3 instances, synchronous replication |
| Stateless Deployments (admin-panel, tenant-panel, platform-api, oauth2-proxy, dex) | 2 replicas | 3 replicas, one per node (topology spread) |

What Apply HA does **not** touch, because it is already covered or handled
differently:

- **etcd** — already a 3-server quorum once you have three servers.
- **Traefik ingress** — already runs on every node.
- **The mail server** — stays single-replica; failover is handled separately
  (see [Mail HA](#mail-ha) below).
- **Per-tenant workloads** — these have their own storage tier and are not
  changed by Apply HA.

## When to enable it

Apply HA only makes sense once the cluster can actually survive a loss:

- **3 or more Ready server nodes.** Below that, the button is disabled — there
  is nowhere to spread a third replica.
- The CNPG operator is running and the platform-config recipient ConfigMap
  exists (both are present after a normal install).

A recommendation banner appears automatically once you reach three servers and
the cluster is still in Local mode. Grow to three servers first
([Nodes & cluster](nodes-and-cluster.md)), then apply.

## The apply flow

1. Go to **Cluster → Cluster Policies** (the platform storage policy card lives
   here).
2. Click **Apply HA**. A confirmation modal lists every change it will make.
3. Confirm. The backend runs three independent patch loops — Longhorn volumes,
   stateless Deployments, then the CNPG cluster.
4. A progress modal reports each resource as it scales. **Partial results are
   shown, not hidden:** if one Longhorn volume fails to patch while the rest
   succeed, you see exactly which one and why, and you can re-click Apply HA
   after the underlying issue clears.

Every Apply HA / Revert writes an audit-log row with the full before/after and
per-resource result.

!!! tip "Partial failures are safe to retry"
    Each loop is independent and idempotent. If CNPG can't scale up because a
    node is short on resources, your primary is untouched — fix the resource
    issue and re-apply. A Longhorn volume that's mid-detach? Wait for it to
    settle and re-click.

## Reversibility

HA is fully reversible. **Revert to Local** runs the same three loops backwards:

- Longhorn volumes 3 → 1 (extra copies deleted).
- Stateless Deployments 3 → 2.
- CNPG cluster 3 → 1 (standby pods removed; the primary keeps all data).

**Reverting loses no data anywhere.** CNPG drops the standbys cleanly and the
primary retains everything; Longhorn deletes the surplus replicas after they've
finished syncing down.

After any Apply HA or Revert, run the cluster smoke test to confirm the new
shape settled:

```bash
make smoke
```

## Mail HA

The mail server (Stalwart) is the one stateful service Apply HA leaves at a
single replica — clustering Stalwart across pods over shared storage risks
mailbox corruption. Instead, mail survives node loss through a different,
purpose-built mechanism:

- An **active node** binds the mail ports and serves traffic.
- The mail store is replicated to a **standby** on a roughly five-minute
  cadence.
- On active-node failure, the platform can **fail over** to the standby.

You configure the active node, the standby set, and automatic-failover behaviour
on **Email → Operations** (the Placement & DR card). For redundant ingress to
mail without DNS changes, also pick a multi-node **port-exposure** mode — see
[Mail operations](mail-operations.md).

The full failover/failback model, thresholds, and the manual cutover path are in
the
[Mail HA & Failover runbook](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_HA_FAILOVER.md).

??? info "Under the hood"
    Apply HA patches `platform-storage-policy`. To stop Flux from reverting the
    imperative scale, the stateless Deployments declare no `replicas:` field
    (Flux never claims it; the reconciler writes it via the `/scale`
    subresource), and the CNPG `Cluster.spec.instances` is stripped from the
    manifest by the overlay's Flux patch so the operator defaults it to 1 and
    the reconciler then patches it to 3. Smoke tests 8 and 9 assert that, in HA
    tier, every stateless Deployment has ≥3 ready replicas across ≥2 nodes and
    that CNPG reports `readyInstances === spec.instances`. Mail failover relies
    on the Longhorn HA volume rebinding to a new node (~30–60 s recovery) rather
    than active-active pods. Full design:
    [HA Mode](https://github.com/insulahq/insula/blob/main/docs/architecture/HA_MODE.md).
