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
