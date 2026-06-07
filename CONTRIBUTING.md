# Contributing to Insula

Thanks for your interest in improving Insula. This guide covers the dev setup,
the conventions the CI enforces, and how releases are cut.

By contributing you agree your contributions are licensed under the project's
[AGPL-3.0](LICENSE).

## Development setup

Requires **Node.js 22+** and **Docker**.

```bash
git clone https://github.com/insulahq/insula.git
cd insula
npm install                  # installs all workspaces (npm workspaces monorepo)
./scripts/local.sh up        # full k3s-in-Docker stack
```

Dev servers (against the local stack):

```bash
npm run dev -w @insula/backend          # API :3000
npm run dev -w @insula/admin-panel      # admin UI :5173
npm run dev -w @insula/tenant-panel     # tenant UI :5174
```

### The api-contracts build gotcha

`packages/api-contracts` is the **single source of truth** for all API types
(Zod schemas + inferred TypeScript types). The backend and both panels import
from `@insula/api-contracts`, so its `dist/` must be built before they
typecheck. It uses TypeScript project references, and a plain `npm run build`
**honours a stale `tsbuildinfo` and can emit nothing**. Always force it:

```bash
npm run build -w @insula/api-contracts -- --force
# or, if a worktree's circular bin symlink trips npm:
node node_modules/typescript/bin/tsc -b packages/api-contracts --force
```

Never define API request/response types in `backend/src` or `frontend/.../types`
— add them to `packages/api-contracts` and import them everywhere.

## Quality bar (CI-enforced)

Before opening a PR, run the same gates CI does:

```bash
npm run lint -w @insula/backend && npm run typecheck -w @insula/backend
npm run lint -w @insula/admin-panel && npm run typecheck -w @insula/admin-panel
npm run lint -w @insula/tenant-panel && npm run typecheck -w @insula/tenant-panel
npm run test -w @insula/backend         # Vitest
find scripts -name '*.sh' -print0 | xargs -0 shellcheck   # shell guards/harnesses
```

- **Tests:** unit + integration with Vitest; target **80%+ coverage** for new
  code (Phase 1 floor is 70%). New features and bug fixes land **with tests** —
  ideally written first (TDD).
- **Infrastructure guards:** `scripts/ci-*.sh` encode invariants (firewall,
  admin-auth gates, image-org fork-safety, …) and run in Infrastructure CI. If
  you add an invariant, add a guard and a `scripts/test-*.sh` harness.
- **Immutability & small files:** prefer new objects over mutation; keep files
  focused (≈200–400 lines, 800 max).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <summary>

<body — what & why>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
A change that breaks operators or APIs MUST include a `### BREAKING` section in
the body and the CHANGELOG entry (see below) — the auto-upgrade path keys off it.

## Versioning & releases

The platform version uses **CalVer `YYYY.M.PATCH`** — e.g. `2026.6.1` (no
leading-zero month, so it stays valid SemVer and orders correctly under
`sort -V` / the `semver` library; **never compare versions as raw strings**). It
will live in a `platform/VERSION` file introduced by the version-spine PR; until
then CI derives the build version from the latest git tag. Cadence is
**ad-hoc**: a release is cut when accumulated changes warrant it, not on a fixed
schedule.

- Day-to-day PRs do **not** touch `platform/VERSION`; CI stamps a
  `<version>-<sha>` build for the dev cluster automatically.
- Bumping: same-month patch → bump `PATCH`; first release of a new month →
  `YYYY.M.1`. Pre-releases are `-rc.N`.
- Releases are cut manually (a `scripts/cut-release.sh` helper is on the
  roadmap). A `### BREAKING` CHANGELOG section gates auto-upgrade.

Background: [docs/history/04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md](docs/history/04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md).

## Pull requests

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep PRs focused; fill in the PR template (summary + test plan).
3. Green CI (lint, typecheck, tests, infra guards) is required.
4. A local `pre-push` hook may lint+typecheck all workspaces — keep it; don't
   bypass with `--no-verify`.

## Reporting bugs / requesting features

Use the issue templates. For **security** vulnerabilities, do **not** open a
public issue — follow [SECURITY.md](SECURITY.md).
