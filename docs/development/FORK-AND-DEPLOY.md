# Fork & Deploy

How to run the platform from your own fork. Covers container-image fork-safety
(the `insulahq/insula` canonical org → your org). Licensing, contribution, and
the broader fork on-ramp are documented separately (`CONTRIBUTING.md`,
`LICENSE`).

> **Status:** image-org fork-safety landed in the W2 PR of the holistic release
> & upgrade plan. The remaining surface (§4) is tracked as a follow-up.

## 1. Local development — nothing to do

`./scripts/local.sh up` **builds every image locally** and imports it into the
embedded k3s containerd under the canonical tag (`ghcr.io/insulahq/insula/*`).
It never pulls from GHCR, so a fork's local stack works unchanged — no repoint,
no registry login, no overlay edits.

## 2. CI — automatic

Every image-building workflow derives its push org from the GitHub context:

```yaml
env:
  IMAGE: ghcr.io/${{ github.repository }}/file-manager
```

On a fork, `github.repository` is `your-org/your-fork`, so your CI publishes to
**your own GHCR** (`ghcr.io/your-org/your-fork/*`) using the fork's
`GITHUB_TOKEN` — no canonical-registry 403, no secrets you don't have. A
mixed-case owner is fine: the sidecar workflows and `build-deploy.yml` run the
image through `docker/metadata-action` (which lowercases it), and GHCR itself
normalizes OCI references to lowercase server-side, so even the paths that go
straight to `build-push-action` (e.g. `release.yml`) work. Pull-request builds
still skip the push entirely (`event != pull_request`), so fork PRs need no
secrets.

The CI guard `scripts/ci-image-org-check.sh` keeps this honest: it fails the
build if a workflow hardcodes `ghcr.io/insulahq/insula` instead of deriving it.

## 3. Deploying a fork to a real cluster — run preflight

The static kustomize manifests (`k8s/base/**` and `k8s/overlays/**`) cannot read
the GitHub context, so they hardcode the canonical org. Before
`bootstrap.sh`/Flux deploys your fork, repoint them to the org your CI pushed to:

```bash
# auto-detects the target from `git remote get-url origin`
./scripts/preflight-image-org.sh

# or be explicit
./scripts/preflight-image-org.sh --owner your-org/your-fork

# CI/dry mode: exit 3 if a repoint is still pending, 0 if aligned
./scripts/preflight-image-org.sh --check
```

It rewrites **only** the `ghcr.io/insulahq/insula/` prefix across the `k8s/`
tree, so third-party images (`cloudnative-pg`, `bulwarkmail`, `stakater`, …) are
never touched. It is idempotent and a no-op on the canonical repo.

> The repointed manifests are a **fork-local** change. Do **not** commit them
> back upstream — the CI guard rejects a non-canonical org in the canonical
> repo's overlays.

## 4. Not yet covered (follow-up)

Two image surfaces are **not** repointed by `preflight-image-org.sh` yet. Until
the planned `IMAGE_PREFIX` consolidation lands, a fork that needs them must set
them by hand:

1. **Backend-spawned runtime images** — `file-manager`, `node-terminal`,
   `private-worker-agent`, and the mail/backup helper images are read from the
   backend's own config, which defaults to the canonical org. Override per image
   via the existing env knobs (`FILE_MANAGER_IMAGE`, `NODE_TERMINAL_IMAGE`,
   `PRIVATE_WORKER_AGENT_IMAGE`, …) — set them in your backend Deployment /
   `platform-config` (preflight already repoints the values that live in the
   manifests; the compiled-in *defaults* are what you'd otherwise inherit).
2. **Flux image-automation CRs** — `ImageRepository`/`ImagePolicy` objects watch
   the canonical registry. A fork using Flux image automation must point these
   at its own GHCR (or disable automation and pin tags).

The follow-up consolidates every platform image reference behind a single
`IMAGE_PREFIX` so one value (derived in CI, set once for a fork) covers all
three surfaces. Tracked against W2 in the Holistic plan.

## 5. Verify

```bash
./scripts/test-image-org.sh        # preflight + guard unit tests
./scripts/ci-image-org-check.sh    # the CI fork-safety guard
```
