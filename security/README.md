# `security/` — component CVE & version watch

This directory is the machine-checkable core of Insula's component watch
(ADR-050). The human process — cadence, triage, SLAs, how a fix flows to a
release — lives in the runbook: **[docs/operations/COMPONENT_WATCH.md](../docs/operations/COMPONENT_WATCH.md)**.

## Files

| File | What it is |
|------|------------|
| [`components.yaml`](components.yaml) | **Registry** — the single source of truth: every watched component, its tier, the exact version we run, where that version is pinned, and where to watch for new releases/advisories. |
| [`cve-ledger.yaml`](cve-ledger.yaml) | **Ledger** — active/triaged CVEs. A finding with **any** entry (incl. `open`) is "tracked" and won't fail the PR gate; only untracked findings do. |

## What keeps it honest

`scripts/ci-component-watch-check.sh` runs in Infrastructure CI and fails on:

1. **Schema** — missing/invalid fields in either file; a ledger `component` with no registry entry.
2. **Drift** — a `pin_check: true` component whose `pinned` literal is no longer present in `pin_source`.
3. **Coverage** — an `image:`/`imageName:` under `k8s/` or a chart/binary pin in `scripts/bootstrap.sh` that maps to no registry component.
4. **SLA** — an `open` KEV/critical ledger entry past its tier SLA with no `mitigation` (report-only until the seeded backlog clears, then enforcing).

So the registry cannot silently drift from reality, and a new component cannot
ship untracked.

## Day-to-day

```bash
scripts/component-watch.sh --status     # tiered table: component · tier · pinned · open CVEs
scripts/component-watch.sh --drift      # registry vs actual pins (offline)
scripts/component-watch.sh --scan       # osv-scanner + govulncheck over lockfiles/modules
scripts/component-watch.sh --latest     # components behind their upstream (online; needs gh)
bash scripts/ci-component-watch-check.sh # the full CI guard, locally
```

The weekly sweep (`.github/workflows/component-watch.yml`) runs `--scan`/`--latest`
and opens/updates a rolling tracking issue. Dependabot (`.github/dependabot.yml`)
proposes the actual dependency-bump PRs; the registry/ledger remain the source of
truth for tiering and waivers.

## Adding a component

Add an entry to `components.yaml` (the coverage guard will otherwise fail), pick a
tier with the rubric in the runbook, and set `pin_source`/`pin_check`. See the
field reference at the top of `components.yaml`.
