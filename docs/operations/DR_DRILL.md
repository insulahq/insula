# DR Drill

Rehearses recovery from a **Tier-1 secrets bundle** — proving the bundle you
hold can actually bring a platform back, *before* a real disaster makes you find
out. Run by `scripts/dr-drill.sh`.

> **This drill never runs in public CI.** It needs the operator's **age private
> key** and (optionally) a **super_admin report token** — both far too sensitive
> to sit in a public-repo GitHub Actions secret. Run it **manually** or from a
> **private host** (your workstation, an internal ops box, a private runner).
> See [Why not CI](#why-not-ci).

See also: [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) (the real restore),
[SECRETS_LIFECYCLE.md](SECRETS_LIFECYCLE.md) (where bundles + keys live).

## TL;DR

```bash
cp scripts/dr-drill.env.example scripts/dr-drill.env   # gitignored
chmod 600 scripts/dr-drill.env                         # fill in BUNDLE + AGE_KEY
$EDITOR scripts/dr-drill.env

./scripts/dr-drill.sh                      # --mode validate (default): static, fast, no cluster
./scripts/dr-drill.sh --mode dind          # + real restore library (+ live-cluster API check if a cluster is up)
./scripts/dr-drill.sh --mode bootstrap     # + REAL recovery onto a throwaway VM (gold standard)
```

Exit code `0` = drill passed, `1` = drill failed (bundle unrecoverable), `2` =
usage error. A failed drill means **fix your DR posture now**, not later.

## Modes — fast → faithful

Each mode is a strict superset of the one above. Pick by how much fidelity you
need vs how much time/infra you can spend.

| Mode | What it proves | Needs | Time |
|------|----------------|-------|------|
| `validate` (default) | The bundle **decrypts** with your age key and is **well-formed** — ≥5 Secret YAMLs, valid structure, `MANIFEST.txt` present. | age key only | seconds |
| `dind` | All of `validate`, **plus** the production restore *tooling* (`scripts/lib/apply-secrets-bundle.sh`: `MANIFEST.json` parse, profile gating, `skipAtRestore`) runs clean on **this** bundle. **If** a cluster is reachable, it *also* server-side dry-runs every restored Secret against the real Kubernetes API; if not, that one sub-check is **skipped** (not failed) and the restore-library result stands. | age key (a reachable cluster — `./scripts/local.sh up` — adds the server-side check) | ~½–1 min |
| `bootstrap` | All of `validate`, **plus** the **real** recovery path — `bootstrap.sh --secrets-bundle` provisions a throwaway VM *from the bundle* and the recovered `platform-api` actually reaches `Available`. | age key + a throwaway VM + SSH key + a drill domain | minutes |

**Why `dind` does not boot a full platform off the bundle:** a drill bundle comes
from staging/production, so its DB credentials and encryption key won't match a
*local dev* Postgres. Bringing the local platform up against foreign credentials
would fail on a credential mismatch — a **false** failure that tells you nothing
about the bundle. So `dind` exercises the real restore tooling + cluster API
acceptance (the parts that genuinely catch bundle/tooling regressions) and leaves
the end-to-end "platform serves traffic off the bundle" proof to `bootstrap`,
which provisions Postgres *from* the bundle and therefore matches.

## Setup

1. Copy the template and fill it in (it is gitignored — never commit it):
   ```bash
   cp scripts/dr-drill.env.example scripts/dr-drill.env
   chmod 600 scripts/dr-drill.env
   ```
2. Fetch a fresh bundle to drill (see [SECRETS_LIFECYCLE.md](SECRETS_LIFECYCLE.md)):
   ```bash
   make secrets-fetch HOST=root@<server>     # writes bundle + operator key locally
   ```
3. Point `DR_DRILL_BUNDLE` + `DR_DRILL_AGE_KEY` at them. For `bootstrap` mode also
   set `DR_DRILL_TARGET` / `DR_DRILL_SSH_KEY` / `DR_DRILL_DOMAIN`.

Config precedence: **flags > environment > `scripts/dr-drill.env`**. Anything in
the env file can be overridden per-run on the command line.

## Running each mode

```bash
# Static integrity — safe to run often, anywhere, no cluster:
./scripts/dr-drill.sh --mode validate --bundle /path/to/bundle.tar.age --age-key /path/to/operator.key

# Tooling + live local-cluster acceptance (bring a local cluster up first):
./scripts/local.sh up
./scripts/dr-drill.sh --mode dind

# Real recovery onto a throwaway VM — the gold standard.
# WARNING: --target is WIPED and re-bootstrapped. Never point it at a live cluster.
./scripts/dr-drill.sh --mode bootstrap \
    --target root@drill-vm.example.test \
    --ssh-key ~/hosting-platform.key \
    --domain drill.example.test
```

## Reliability

- **Timeouts.** The restore/bootstrap phase is wrapped in `timeout`
  (`DR_DRILL_TIMEOUT`, default 1800s) and the readiness wait has its own cap, so a
  hung restore **fails fast** instead of stalling a scheduled run forever. (The
  old CI drill only failed after a long, opaque timeout — this is the fix.)
- **Self-test (`--meta-test`).** Corrupts the bundle in-memory and asserts the
  drill *fails* — proving the drill can actually detect breakage. Run it after any
  change to `dr-drill.sh`:
  ```bash
  ./scripts/dr-drill.sh --meta-test    # exits 0 ONLY if the drill caught the corruption
  ```
- **Honest pass.** A `validate` pass is reported as `validate`, not dressed up as
  a recovery. Only `bootstrap` asserts a platform actually came back.

## Reporting

The drill prints a JSON report to stdout (or to `--report <file>`). It matches the
`recordDrDrillRunRequest` API contract, so you can POST it to the platform-api
**DR Drill** ingestion endpoint and the admin **DR Drill** tab will surface
history + a rolling pass-rate:

```bash
DR_DRILL_WEBHOOK_URL=https://admin.<apex>/api/v1/system-backup/dr-drill/runs \
DR_DRILL_WEBHOOK_TOKEN=<super_admin service JWT> \
./scripts/dr-drill.sh --mode dind --report /var/log/dr-drill/last.json
```

The webhook is TLS-verified (set `DR_DRILL_WEBHOOK_INSECURE=1` only for an
internal CA you trust). Reach the endpoint over a **private/mesh** network — the
report token is a super_admin credential.

## Automating on a private host

Because the drill is just a script with a gitignored env file, schedule it with
whatever your private host already runs. Two examples:

**systemd timer** (`/etc/systemd/system/dr-drill.{service,timer}`):
```ini
# dr-drill.service
[Service]
Type=oneshot
User=ops
WorkingDirectory=/opt/insula
EnvironmentFile=/opt/insula/scripts/dr-drill.env
ExecStart=/opt/insula/scripts/dr-drill.sh --mode dind --report /var/log/dr-drill/last.json

# dr-drill.timer
[Timer]
OnCalendar=Mon 04:00
Persistent=true
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl enable --now dr-drill.timer
```

**cron** (private host, age key readable only by this user):
```cron
0 4 * * 1  cd /opt/insula && ./scripts/dr-drill.sh --mode dind --report /var/log/dr-drill/last.json >> /var/log/dr-drill/cron.log 2>&1
```

Recommended cadence: `validate` daily (cheap), `dind` weekly, `bootstrap` monthly
or before any release that touches bootstrap / the secrets bundle format.

## Interpreting a failure

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `bundle decryption failed` | Wrong age key for this bundle, or truncated/corrupt bundle | Confirm the key matches the bundle's `MANIFEST.txt` recipient; re-fetch the bundle |
| `bundle too small (<5 Secret YAMLs)` | Bundle generated against a bare/half-provisioned cluster | Re-generate from a fully-provisioned source; check `bootstrap.sh` bundle export |
| `restore library failed on bundle` (dind) | `apply-secrets-bundle.sh` / `MANIFEST.json` regression | Inspect `apply-secrets-bundle.sh`; the restore tooling itself is broken |
| `N restored Secret(s) rejected (server dry-run)` (dind) | A restored Secret is malformed for the cluster's API | Inspect the rejected Secret YAML in the bundle |
| `bootstrap --secrets-bundle failed` | Real recovery path broken — the most important failure | Read the bootstrap log; this is exactly what a real DR would hit |
| `recovered platform-api not Available` | Platform can't consume the restored secrets | DB creds / encryption key mismatch between bundle and what `bootstrap` provisioned |

## Why not CI

The earlier `dr-drill.yml` GitHub Actions workflow ran weekly against staging, but
to do so it stored the operator's **age private key**, a long-lived **super_admin
report token**, and bundle-fetch credentials as **public-repo** Actions secrets.
For a public OSS repo that is an unacceptable blast radius: a single workflow or
supply-chain compromise would leak the key that decrypts every Tier-1 bundle.
The drill was therefore removed from CI and lives here as a script you run where
those secrets already are — locally or on a private host. Do **not** re-add
`STAGING_AGE_KEY` / `STAGING_DRILL_WEBHOOK_*` / `STAGING_BUNDLE_FETCH_*` to the
public repo.
