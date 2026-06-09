# R14 — User-Manual Website (plan locked 2026-06-07)

> Roadmap detail for [ROADMAP.md R14](ROADMAP.md#r14--user-manual-website).

## Locked decisions (operator, 2026-06-07)

| Decision | Choice | Rationale |
|---|---|---|
| Location | **Monorepo `documentation/`** | Same-PR doc updates, CI-enforceable accuracy, generated reference reads the source tree, docs publish at the release commit |
| Builder | **Material for MkDocs now** (pin 9.7.x, its final feature release), migrate to **Zensical** once it leaves alpha | Mature search/plugins today; Zensical (v0.0.44 alpha, same team) natively reads `mkdocs.yml`, so the migration is config-compatible by design |
| Hosting | GitHub Pages via `actions/deploy-pages` at **`insulahq.github.io/insula`** | No DNS setup now; adding a custom domain later auto-redirects the github.io URLs |
| v1 scope | **All three guides** (operator + admin + tenant) before announcing | Complete on day one |
| Versioning | v1 is **latest-only**, footer stamped with `platform/VERSION` | Keeps the plugin surface Zensical-compatible (no `mike` yet); revisit when version snapshots are actually needed |

**Authoring contract:** plain `mkdocs.yml` + Markdown + mainstream python-markdown
extensions only. Every plugin choice must be checked against Zensical
compatibility (<https://zensical.org/compatibility/>) so the future switch stays
a one-line builder change.

## Site structure

```
documentation/
├── mkdocs.yml            # Material config, Zensical-compatible subset
├── docs/
│   ├── index.md          # product overview
│   ├── getting-started/  # install, bootstrap, fork-and-deploy
│   ├── operator/         # cluster ops, HA, backups/DR, mail, hardening, upgrades
│   ├── admin/            # admin-panel guide
│   ├── tenant/           # end-customer guide (white-label base for forks)
│   └── reference/        # GENERATED — do not hand-edit
├── overrides/            # branding
└── gen/                  # build-time generation scripts
```

**Content stance:** the manual is *rewritten user-facing content*, not a mirror.
`docs/architecture|operations|features` remain the engineering truth and source
material; the manual adapts per audience. Where the admin/tenant guides need the
original requirement specs, mine them from the git history.

## Accuracy system (in leverage order)

1. **Manual-impact CI guard** — `scripts/ci-manual-impact-check.sh`: a PR touching
   `frontend/*/src/pages/**`, `packages/api-contracts/src/**`, backend route files,
   or `bootstrap.sh` flags must touch `documentation/docs/**` or carry a
   `Manual-Impact: none` trailer. Report-only for 2 weeks, then enforcing.
2. **Generated reference** (cannot rot): API reference from the `swagger` module's
   OpenAPI output · `platform-ops` CLI pages from `--help` · error-code table from
   api-contracts constants · platform-settings/feature-flag tables from schema ·
   supported-OS matrix from `bootstrap.sh check_os`.
3. **Strict builds**: broken nav/links/anchors fail CI (`mkdocs build --strict`;
   extend `scripts/ci-docs-link-check.sh` to `documentation/`).
4. **Screenshot automation** (phase G): release-time Playwright job re-drives the
   panels and regenerates screenshots.
5. **Freshness stamps**: per-page `verified: <calver>` front-matter;
   `cut-release.sh` warns on pages not re-verified within N minor releases.
6. **Release coupling**: deploy on every main merge; footer shows
   `platform/VERSION`; CHANGELOG page transcludes the repo `CHANGELOG.md`.
7. **PR-template checkbox**: "User-visible change → manual updated / waived".

## Delivery phases

| PR | Scope | Est. |
|---|---|---|
| A | Scaffold `documentation/` + Material build + Pages deploy workflow (path-filtered build on PRs, deploy on main) | 0.5 d |
| B | Information architecture + getting-started (operator install path) | 1 d |
| C | Generated reference pipeline + strict link gates | 1–1.5 d |
| D | Operator guide (runbook adaptation) | 1–2 d |
| E | Admin guide | 1–2 d |
| F | Tenant guide (+ screenshots, history-mining) | 1–2 d |
| G | Freshness automation (guard → enforcing, screenshot job, stamps) | 1 d |
| H | Announce v1 | 0.5 d |
