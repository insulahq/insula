# Integration Tests — config profile & secret hygiene

The `scripts/integration-*.sh` harnesses run against a **live cluster**. This doc
covers how they get their cluster coordinates and any confidential inputs without
ever committing them to this public repo. For the broader test philosophy (unit /
smoke / E2E layers) see [TESTING_STRATEGY.md](./TESTING_STRATEGY.md).

## The config profile

Real values live in a **gitignored** profile, never in a committed script:

```bash
cp scripts/integration.env.example scripts/integration.env
$EDITOR scripts/integration.env          # fill in your cluster + creds
ADMIN_PASSWORD=…  ./scripts/integration-all.sh
```

- `scripts/integration.env` — gitignored; your real `ADMIN_HOST`, `SSH_HOST`,
  `HTTPS_TEST_DOMAIN_BASE`, and any external-target credentials.
- `scripts/integration.env.example` — committed template, **placeholders only**.
- `scripts/lib/integration-env.sh` — sourced by harnesses; provides
  `load_integration_env`, `require_env`, `require_or_skip`, `redact`.
- Point at a profile elsewhere with `INTEGRATION_ENV=/path/to/file`.

`integration-all.sh` calls `load_integration_env` and **exports** every value, so
the sub-scripts it launches inherit your real cluster automatically. A sub-script
run standalone reads the same profile if it sources the lib (the exemplars
`ingress-auth-e2e.sh` and `integration-tenant-bundles-restic.sh` do).

## The contract: configured → run, unconfigured → SKIP

Harnesses declare their inputs at the top, **before** any slow work:

```bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
load_integration_env

require_env ADMIN_PASSWORD                       # mandatory → exit 2 (fast) if unset
require_or_skip "off-site backup round-trip" \   # optional/external → exit 77 (SKIP)
    BACKUP_S3_ENDPOINT BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
```

- **`require_env`** — for inputs the suite genuinely can't run without. Fails in
  milliseconds with a clear message instead of dying cryptically mid-run.
- **`require_or_skip`** — for **confidential / external** targets (off-site S3,
  SMTP relays, third-party API tokens). When they aren't configured the suite
  **SKIPs** (exit `77`) instead of hard-failing or running against placeholders.
  A public clone then runs everything that needs only the cluster and cleanly
  skips what needs the operator's private infrastructure.

Exit-code convention (matched by `integration-all.sh`): `0` pass · `77` skipped
(precondition not met — *not* validated) · anything else = real failure.

## No operator infrastructure in committed scripts

Committed scripts use `example.test` / placeholder defaults only — never a real
node IP, apex domain, or credential. **`scripts/ci-no-hardcoded-test-infra.sh`**
(wired into `ci-infrastructure.yml`) fails CI if a real public IP or operator
domain reappears in `scripts/**/*.{sh,md}`. It's the `scripts/` companion to
`ci-no-pinned-domains.sh` and `ci-no-hardcoded-ips.sh`, which scan the `k8s/`
manifest tree.

Allowed and **not** flagged: `example.test`, the `k8s-platform.test` local-dev
apex, and the RFC 5737 documentation IP ranges (`192.0.2.x`, `198.51.100.x`,
`203.0.113.x`) used as test fixtures.

## If you must add a new external dependency

1. Add its variables to `scripts/integration.env.example` (placeholders + a
   one-line comment on what each is).
2. In the harness, gate the dependent work with
   `require_or_skip "<what it does>" VAR1 VAR2 …`.
3. Never commit the real value — it goes in your local `scripts/integration.env`.

## Running the suite: tiers, timeouts, fail-fast, timing

The runner (`integration-all.sh`) is fast-by-default and slice-able. With no flags
it behaves exactly as before (smoke gate + every suite); the flags let you scope a
run and bound its wall-clock.

```bash
./scripts/integration-all.sh --list                 # show the resolved selection (no cluster needed)
./scripts/integration-all.sh --tier core             # skip the slow + external suites
./scripts/integration-all.sh --only pvc,grow         # just these suites
./scripts/integration-all.sh --exclude postgres-pitr # everything but this
./scripts/integration-all.sh --tier smoke            # only the smoke gate
./scripts/integration-all.sh --report-json out.json  # machine-readable run report
./scripts/integration-all.sh --no-smoke              # skip the pre-gate
```

- **Tiers.** Each suite is `core` (default), `slow` (the long poles — `staging-all`,
  `postgres-pitr`, …), or `external` (needs confidential off-cluster targets; those
  also `require_or_skip` internally). `--tier`, `--only`, `--exclude` filter the run.
- **Smoke gate.** `smoke-test.sh` runs first and the run **aborts on red** — fail in
  seconds, not 40 minutes, when the platform is already broken (`--no-smoke` skips).
- **Per-suite hard timeout.** Every suite runs under `timeout` (default 1800s,
  per-suite overrides via `SUITE_TIMEOUT`/`--timeout`). A hung harness is **killed
  and reported as `TIMED OUT`** instead of stalling the whole run forever.
- **Timing + JSON.** The run prints a per-suite "slowest first" table and, with
  `--report-json`, emits `{counts, suites:[{name,tier,rc,seconds}], …}`.

### Fail-fast polling in a harness (stop waiting the full deadline)

The chronic time-sink inside harnesses is a poll loop that waits the **entire**
deadline even after the thing it waits on has already entered a terminal failure
(`CrashLoopBackOff`, `task=failed`, `ReplicaFailure`). Two helpers fix this with a
`FAIL_RX` lever — match it and the wait aborts immediately:

```bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-lib.sh"

# il_wait_for <deadline_s> <desc> <ok_rx> <fail_rx|-> <cmd-string>
il_wait_for 300 "tenant pod Ready" 'Running' 'CrashLoopBackOff|Error' \
  "kubectl -n $ns get pod -l app=$app -o wide"      # fails at ~4s if it crashes

il_wait_http 600 "https://$host/" 200 '^4'           # bail on any 4xx
```

`lib/private-worker-helpers.sh`'s `wait_for`/`wait_for_http` take the same optional
`fail_rx` as a trailing arg (backward compatible). **Prefer these over a hand-rolled
`while … sleep N` loop**: a fixed `sleep 300` both slows the happy path and hides a
failure until the deadline. `lib/integration-lib.sh` also provides counters
(`il_ok/il_fail/il_skip/il_summary`), per-phase timing (`il_phase_begin/_end`), and
cleanup-trap registration (`il_on_cleanup` + `trap il_run_cleanups EXIT`).
