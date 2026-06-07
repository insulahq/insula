# Spike: in-cluster Flux re-pin + SUC rollback behaviour (ADR-045 W16 / PR-18)

**Decision gate:** locked decision **#14** — "Flux pinning spike before implementation".
This spike validates the mechanism W13 (in-cluster upgrade re-pin) depends on, and
resolves the chicken-and-egg (#16) and the branch-vs-tag model question, **before**
the W13 reconciler is built.

**Verdict: GO**, with three design constraints (below).

---

## 1. Method

A repeatable, **non-destructive** experiment — `scripts/spike-flux-repin-validate.sh`
— run on the **testing** cluster (single-node k3s, Flux tracking the `staging`
branch). It operates ONLY on a throwaway `GitRepository/spike-repin-test` it
creates and deletes; it never touches the live `platform` Kustomization or the
`hosting-platform-*` GitRepositories. Staging was left alone (its `platform`
Kustomization is and stays `suspend: true`).

The experiment:
1. Create a throwaway GitRepository pinned to `ref.branch: staging`.
2. PATCH `spec.ref` → `ref.tag: v2026.6.2` (the in-cluster "re-pin").
3. Observe whether Flux re-fetches and serves the tag's artifact.
4. PATCH back to the branch (reversibility).

## 2. Findings

### F1 — In-cluster Flux re-pin WORKS and is reversible ✅ (proven)

PATCHing `GitRepository.spec.ref` from a branch to a tag (and back) is honoured by
Flux's source-controller, which re-fetches the new revision's artifact within one
reconcile interval. Evidence (testing cluster, real run):

```
initial:    staging@sha1:4aea5a4a03d3f73459d941ef4365dedca7b30260
re-pin →    v2026.6.2@sha1:27aa0c399daf2526ed65d74d20006fa9f835c25e   (Ready: True)
reverse →   staging@sha1:4aea5a4a03d3f73459d941ef4365dedca7b30260
```

This is the load-bearing mechanism for W13: a process with the cluster kubeconfig
can move the cluster's deployed revision by a single `spec.ref` merge-patch, with
no external git push and no `kubectl apply` of new manifests.

### F2 — The chicken-and-egg (#16) is MOOT in our architecture ✅

The roadmap's #16 ("`oldPlatformApiImageTag` baked into the upgrade-time
controller") exists because an **in-cluster pod** that re-pins Flux would be
**rolled and replaced by its own re-pin** the instant the new revision changes the
`platform-api` image — killing the process mid-upgrade.

In the pull model we actually built (W8/W17), the re-pinner is **`platform-ops`
running on the host** (root + the node kubeconfig), **not a pod**. It is not part
of any Deployment that an upgrade rolls, so it cannot self-destruct. The #16
old-image-bake mitigation is therefore **only needed for an in-cluster-pod
reconciler, which we do not use** — W13 must drive the re-pin host-side.

### F3 — Branch-vs-tag: dev/staging track branches; production tracks a tag

The deployed model tracks a **branch** (`gitrepository.yaml` → `branch: main`,
`-staging` → `staging`, testing follows `staging`). A branch auto-follows HEAD, so
**dev/staging are already "auto-updating"** — there is nothing to re-pin; CI moving
the branch IS the update (locked decision #18: staging auto-update ON — satisfied
by the branch model, no reconciler needed).

W13's tag re-pin is meaningful **only for production**, which must track a
**release tag** (`ref.tag: vYYYY.M.PATCH`) rather than a branch. "Upgrading
production" = `platform-ops` PATCHing that GitRepository's `spec.ref.tag` to a newer
verified release tag. Production auto-update is **OFF by default** (#18) — the
re-pin is operator-triggered (or, when explicitly enabled, by the auto-update
reconciler honouring the same `auto_update` + BREAKING + preflight gates).

> **Provisioning follow-up:** production is not yet provisioned. Its bootstrap must
> create the production GitRepository with `ref.tag` (seeded to the install's
> `platform/VERSION` tag), not `ref.branch`. Captured here so W13 + the production
> bootstrap path stay consistent.

### F4 — SUC rollback interaction is orthogonal and composable

A bad upgrade's rollback (W16) has two halves: **data** (snapshot-restore of
Longhorn/CNPG — separate subsystem) and **revision** (re-pin Flux back to the
previous tag — proven reversible in F1). Because the re-pinner is host-side
`platform-ops` (F2), it can drive the rollback re-pin **even while the cluster is
mid-rollback** — it is not itself being rolled back. SUC (W12) upgrades k3s/the
node OS and is likewise driven by host-side Plan creation; an SUC Plan and a Flux
re-pin are independent operations the orchestrator sequences.

## 3. GO — W13 design constraints

1. **Host-side re-pinner.** W13's re-pin is performed by `platform-ops upgrade
   apply` (host-side, root + kubeconfig), never an in-cluster pod. This sidesteps
   #16 entirely.
2. **Production tracks a tag.** The re-pin PATCHes `GitRepository.spec.ref.tag`.
   dev/staging keep branch-tracking (auto-follow); the reconciler is a no-op there.
3. **Gated.** The automated path honours `auto_update` (prod OFF/staging N/A per
   #18) AND a `### BREAKING` short-circuit AND W14 pre-flight; dry-run by default;
   the manual `platform-ops upgrade apply` is operator-driven.

## 4. Re-running

```bash
KUBECONFIG=/etc/rancher/k3s/k3s.yaml ./scripts/spike-flux-repin-validate.sh \
  [--url <repo>] [--branch <b>] [--tag <t>]
```
Self-cleaning (deletes the throwaway on exit), safe to run against any cluster.
