# DR drill log

Append one row per drill. `DISASTER_RECOVERY.md` points at this file for the
measured RTO, so a row here is the only thing that makes that number real.

**Cadence:** quarterly for `dind`, annually (or before any production cutover)
for `bootstrap`. A drill older than its cadence should be treated as an
untested backup, because that is what it is.

## How to run one

See `DR_DRILL.md` for the mode descriptions. The exact procedure is in
[§ Exact procedure](#exact-procedure) below — follow it verbatim so successive
runs are comparable.

## Log

| Date | Mode | Result | Duration | Bundle age | Run by | Notes |
|---|---|---|---|---|---|---|
| 2026-09-11 | `validate` | ✅ pass | 1 s | 81 d | staging1 | 48 entries decrypted, 45 Secret YAMLs, both smoke assertions passed |
| 2026-09-11 | `dind` | ✅ pass | 30 s | 81 d | staging1 | All of `validate`, plus the real restore library ran clean AND every restored Secret passed a **server-side dry-run against the live staging cluster** |
| — | `bootstrap` | ⚠️ **never run** | — | — | — | **The full cold-restore RTO has never been measured.** `DISASTER_RECOVERY.md` targets ≤ 2 h; that number is an aspiration, not an observation, until a `bootstrap` row exists here. |

## Exact procedure

### Mode `validate` / `dind` — quarterly, ~1 minute

Run from a cluster server (it needs the age key and a bundle). Nothing is
mutated: `dind` uses a server-side **dry-run**, so it never writes a Secret.

```bash
# 1. Pick the newest bundle.
BUNDLE=$(ls -t /var/lib/hosting-platform/bundles/*.tar.age | head -1)
echo "bundle: $(basename "$BUNDLE")  age: $(( ( $(date +%s) - $(stat -c %Y "$BUNDLE") ) / 86400 )) days"

# 2. Run the drill. `dind` is a strict superset of `validate`; run it when a
#    cluster is reachable, because only then do you get the server-side check.
cd <repo checkout>
DR_DRILL_BUNDLE="$BUNDLE" \
DR_DRILL_AGE_KEY=/var/lib/hosting-platform/operator-key/operator-private.key \
KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  bash scripts/dr-drill.sh --mode dind

# 3. Exit code 0 = pass. Append a row to the table above either way.
```

**Assertions that must all be `passed: true`:**

| Assertion | What a failure means |
|---|---|
| `manifest-has-recipient` | The bundle does not record which age key encrypts it — recovery becomes guesswork. |
| `all-secret-yamls-valid` | The bundle decrypts but its contents are malformed. |
| `restore-lib-emitted-secrets` | The production restore tooling cannot process this bundle. |
| `cluster-accepts-secrets` | Kubernetes would reject the restored Secrets. Skipped (not failed) when no cluster is reachable — **a skip is not a pass**, so note it in the log. |

A failure here means **fix your DR posture now**, not at the next incident.

### Mode `bootstrap` — annually, and before any production cutover

This is the one that produces a real RTO. It provisions a throwaway VM from
the bundle and waits for the recovered `platform-api` to reach `Available`.

```bash
cp scripts/dr-drill.env.example scripts/dr-drill.env   # gitignored
chmod 600 scripts/dr-drill.env
$EDITOR scripts/dr-drill.env     # BUNDLE, AGE_KEY, throwaway VM + SSH key, drill domain

date +%s > /tmp/drill-start
./scripts/dr-drill.sh --mode bootstrap
echo "RTO: $(( $(date +%s) - $(cat /tmp/drill-start) ))s"
```

Record that number in the log table AND in `DISASTER_RECOVERY.md`'s RTO cell.
Destroy the throwaway VM afterwards.

## The dependency this drill does NOT test

Every bundle is encrypted to the operator age key. **If that key is lost,
nothing above is recoverable** — no amount of replication addresses it, and
the drill cannot detect it because the drill is run by someone who has the
key.

On staging the private key currently sits at
`/var/lib/hosting-platform/operator-key/operator-private.key` **on a cluster
node** — i.e. on the very machine a total-cluster-loss scenario assumes is
gone. Confirm an off-cluster copy exists (`OPERATOR_KEY_SETUP.md`: password
manager or paper vault) and note the date of that confirmation here:

| Date confirmed | Where the off-cluster copy lives | Confirmed by |
|---|---|---|
| _not yet confirmed_ | | |
