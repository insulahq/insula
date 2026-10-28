#!/usr/bin/env bash
# ci-stalwart-launcher-check.sh — static invariants of how the Stalwart pod starts.
#
# Stalwart does not run the image ENTRYPOINT. The `stalwart-binary` init
# container copies /usr/local/bin/stalwart into an emptyDir (a plain `cp` drops
# the image's cap_net_bind_service file capability), and the `stalwart`
# container starts a perl launcher that turns transparent huge pages off for the
# process (prctl PR_SET_THP_DISABLE) and execs that copy. Without the file
# capability glibc is not in secure mode, so MALLOC_ARENA_MAX takes effect; the
# pod sysctl net.ipv4.ip_unprivileged_port_start=0 lets the unprivileged copy
# bind the mail ports.
#
# Any one of these pieces drifting breaks mail start-up (copy missing, exec of a
# wrong path, ports refused) or silently undoes the memory fix, so this guard
# fails the build when the rendered manifests no longer hold them together:
#   - init container `stalwart-binary` runs the SAME image as `stalwart`
#   - it copies /usr/local/bin/stalwart to the path the launcher execs
#   - the copy lives on an emptyDir, writable in the init container and mounted
#     read-only in `stalwart` at the same path
#   - the launcher is perl -e <script> --, the script sets PR_SET_THP_DISABLE
#     and execs $ARGV[0]; args are <copy> --config <file under a mounted dir>
#   - MALLOC_ARENA_MAX is only set together with the capability-free copy
#   - the pod sets net.ipv4.ip_unprivileged_port_start=0
#   - every `$` in the inline scripts is written `$$` (Flux postBuild
#     substitution eats a bare `$name`)
# Checked on the base manifest and on every overlay that renders it.
#
# The runtime half (the launcher really runs in the pinned image) is
# scripts/test-stalwart-launcher.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

render() {
  if command -v kustomize >/dev/null 2>&1; then kustomize build "$1"
  elif command -v kubectl >/dev/null 2>&1; then kubectl kustomize "$1"
  else echo "ci-stalwart-launcher-check: needs kustomize or kubectl to render $1" >&2; return 2
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp k8s/base/stalwart-mail/stalwart/deployment.yaml "$WORK/base.yaml"
for o in development staging production; do
  render "k8s/overlays/$o" > "$WORK/$o.yaml"
done

python3 - "$WORK" <<'PY'
import re, sys, yaml

work = sys.argv[1]
COPY_DIR = "/opt/stalwart-bin"
COPY = COPY_DIR + "/stalwart"
ORIGINAL = "/usr/local/bin/stalwart"
failures = []

def fail(src, msg):
    failures.append(f"{src}: {msg}")

def bare_dollars(script):
    """`$` not written as `$$` — Flux postBuild substitution would eat it."""
    return [m.start() for m in re.finditer(r"(?<!\$)\$(?!\$)", script.replace("$$", ""))]

def check(src, dep):
    spec = dep["spec"]["template"]["spec"]
    containers = {c["name"]: c for c in spec.get("containers", [])}
    inits = {c["name"]: c for c in spec.get("initContainers", [])}
    volumes = {v["name"]: v for v in spec.get("volumes", [])}
    main, init = containers.get("stalwart"), inits.get("stalwart-binary")
    if main is None:
        return fail(src, "no `stalwart` container")
    if init is None:
        return fail(src, "no `stalwart-binary` init container")

    if init.get("image") != main.get("image"):
        fail(src, f"stalwart-binary image {init.get('image')!r} != stalwart image {main.get('image')!r} "
                  "(the copy must be the binary of the version that runs)")

    def mount(c, name):
        return next((m for m in c.get("volumeMounts", []) if m["name"] == name), None)
    vol = volumes.get("stalwart-bin")
    if vol is None or "emptyDir" not in vol:
        fail(src, "volume `stalwart-bin` must be an emptyDir")
    im, mm = mount(init, "stalwart-bin"), mount(main, "stalwart-bin")
    if not im or im.get("mountPath") != COPY_DIR or im.get("readOnly"):
        fail(src, f"stalwart-binary must mount stalwart-bin writable at {COPY_DIR}")
    if not mm or mm.get("mountPath") != COPY_DIR or not mm.get("readOnly"):
        fail(src, f"stalwart must mount stalwart-bin read-only at {COPY_DIR}")

    init_script = " ".join(init.get("command", []) + init.get("args", []))
    if not re.search(rf"cp\s+{re.escape(ORIGINAL)}\s+", init_script) or COPY not in init_script:
        fail(src, f"stalwart-binary must cp {ORIGINAL} to {COPY}")
    if re.search(r"cp\s+(-[a-zA-Z]*[ap]|--preserve|--archive)", init_script):
        fail(src, "stalwart-binary must use a plain cp (-a/-p/--preserve would copy the file capability)")

    cmd, args = main.get("command", []), main.get("args", [])
    if len(cmd) != 4 or cmd[0] != "perl" or cmd[1] != "-e" or cmd[3] != "--":
        fail(src, f"stalwart command must be [perl, -e, <launcher>, --], got {cmd[:2] + ['…'] if cmd else cmd}")
    else:
        launcher = cmd[2].replace("$$", "$")
        if "syscall(" not in launcher or not re.search(r"\b41,\s*1\b", launcher):
            fail(src, "launcher must call prctl(PR_SET_THP_DISABLE=41, 1) via syscall()")
        if "exec { $ARGV[0] } @ARGV" not in launcher:
            fail(src, "launcher must `exec { $ARGV[0] } @ARGV`")
    if not args or args[0] != COPY:
        fail(src, f"stalwart args[0] must be the capability-free copy {COPY}, got {args[:1]}")
    if "--config" in args:
        cfg = args[args.index("--config") + 1] if args.index("--config") + 1 < len(args) else ""
        if not any(cfg.startswith(m["mountPath"].rstrip("/") + "/") for m in main.get("volumeMounts", [])):
            fail(src, f"--config {cfg!r} is not under any volume mounted into stalwart")
    else:
        fail(src, "stalwart args must pass --config")

    env = {e["name"]: e for e in main.get("env", [])}
    if "MALLOC_ARENA_MAX" in env and (not args or args[0] == ORIGINAL):
        fail(src, "MALLOC_ARENA_MAX on the image binary is ignored by glibc (AT_SECURE); run the copy")
    if "MALLOC_ARENA_MAX" not in env:
        fail(src, "stalwart env must set MALLOC_ARENA_MAX (the reason the copy exists)")

    sysctls = {s["name"]: str(s.get("value")) for s in (spec.get("securityContext") or {}).get("sysctls", [])}
    if sysctls.get("net.ipv4.ip_unprivileged_port_start") != "0":
        fail(src, "pod securityContext.sysctls must set net.ipv4.ip_unprivileged_port_start=\"0\" "
                  "(the copy has no cap_net_bind_service)")

    if src == "base":  # escaping is a source property; rendered overlays are still pre-Flux
        for name, script in (("stalwart-binary", init_script), ("launcher", cmd[2] if len(cmd) > 2 else "")):
            if bare_dollars(script):
                fail(src, f"{name}: write every `$` as `$$` (Flux postBuild substitution eats a bare `$name`)")

found = {}
for src in ("base", "development", "staging", "production"):
    for doc in yaml.safe_load_all(open(f"{work}/{src}.yaml")):
        if doc and doc.get("kind") == "Deployment" and doc["metadata"]["name"] == "stalwart-mail":
            found[src] = True
            check(src, doc)
    if not found.get(src):
        fail(src, "Deployment stalwart-mail not found")

if failures:
    print("ci-stalwart-launcher-check: FAIL")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("ci-stalwart-launcher-check: OK — launcher, capability-free copy, sysctl and image pin agree "
      "in base + development/staging/production")
PY
