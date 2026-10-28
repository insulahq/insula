#!/usr/bin/env bash
# test-stalwart-launcher.sh — run Stalwart's start-up chain from the manifest, in
# the pinned image, the way the cluster runs it, and prove it does what it is for.
#
# Rendered from k8s/base/stalwart-mail/stalwart/deployment.yaml (`$$` → `$`, as
# Flux postBuild substitution does): the image, the `stalwart-binary` init
# container script, the `stalwart` launcher (command + args), its env, the
# stalwart-config ConfigMap and the pod sysctls. Then, with docker volumes
# standing in for the emptyDir / ConfigMap / data PVC:
#   1. the init script makes a copy of the binary with NO file capability
#   2. the launcher starts Stalwart from that copy and it answers /healthz/live
#   3. the running process: exe = the copy, THP_enabled 0, AT_SECURE 0,
#      MALLOC_ARENA_MAX in its environment, no launcher warning in its log
#   4. with the manifest's sysctls the image user binds port 25 without any
#      capability, and without them it cannot (control: proves 4 tests something)
# A Stalwart image bump that moves the binary, drops perl/getcap or changes the
# user fails here before it can ship.
#
# Run: ./scripts/test-stalwart-launcher.sh   (needs docker, python3 + pyyaml)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

ID="stalwart-launcher-test-$$"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$ID-run" "$ID-ctl" >/dev/null 2>&1
  docker volume rm "$ID-bin" "$ID-cfg" "$ID-data" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── Render what the cluster would run ──────────────────────────────────────
python3 - "$REPO_ROOT" "$WORK" <<'PY' || { echo "could not render the Stalwart Deployment" >&2; exit 1; }
import json, sys, yaml
root, out = sys.argv[1], sys.argv[2]
unflux = lambda s: s.replace("$$", "$")
dep = next(d for d in yaml.safe_load_all(open(f"{root}/k8s/base/stalwart-mail/stalwart/deployment.yaml"))
           if d and d.get("kind") == "Deployment" and d["metadata"]["name"] == "stalwart-mail")
cm = next(d for d in yaml.safe_load_all(open(f"{root}/k8s/base/stalwart-mail/stalwart/configmap.yaml"))
          if d and d.get("kind") == "ConfigMap" and d["metadata"]["name"] == "stalwart-config")
spec = dep["spec"]["template"]["spec"]
main = next(c for c in spec["containers"] if c["name"] == "stalwart")
init = next(c for c in spec["initContainers"] if c["name"] == "stalwart-binary")
mounts = {m["name"]: m for m in main["volumeMounts"]}
plain_env = {e["name"]: unflux(e["value"]) for e in main.get("env", []) if "value" in e}
json.dump({
    "image": main["image"],
    "init_cmd": [unflux(x) for x in init.get("command", []) + init.get("args", [])],
    "init_mount": next(m["mountPath"] for m in init["volumeMounts"] if m["name"] == "stalwart-bin"),
    "entrypoint": unflux(main["command"][0]),
    "argv": [unflux(x) for x in main["command"][1:] + main.get("args", [])],
    "copy": unflux(main["args"][0]),
    "bin_mount": mounts["stalwart-bin"]["mountPath"],
    "cfg_mount": mounts["config"]["mountPath"],
    "data_mount": mounts["stalwart-data"]["mountPath"],
    "env": plain_env,
    "sysctls": {s["name"]: str(s["value"]) for s in (spec.get("securityContext") or {}).get("sysctls", [])},
}, open(f"{out}/spec.json", "w"))
for name, body in cm["data"].items():
    open(f"{out}/cfg-{name}", "w").write(body)
PY
J() { python3 -c "import json,sys; v=json.load(open('$WORK/spec.json'))$1; print(v if isinstance(v,str) else json.dumps(v))"; }
IMAGE=$(J "['image']"); COPY=$(J "['copy']"); BIN=$(J "['bin_mount']"); CFG=$(J "['cfg_mount']"); DATA=$(J "['data_mount']")
echo "image: $IMAGE"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null || { echo "cannot pull $IMAGE" >&2; exit 1; }
IMG_USER=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')

# docker volumes, not bind mounts: works on a remote/DinD daemon too.
for v in bin cfg data; do docker volume create "$ID-$v" >/dev/null; done
docker run --rm --user 0 --entrypoint sh -v "$ID-bin:/b" -v "$ID-data:/d" "$IMAGE" \
  -c "chmod 0777 /b && chown $IMG_USER /d" || { echo "volume setup failed" >&2; exit 1; }
for f in "$WORK"/cfg-*; do
  docker run --rm -i --user 0 --entrypoint sh -v "$ID-cfg:/c" "$IMAGE" -c "cat > '/c/${f##*/cfg-}'" < "$f"
done

# Docker sets net.ipv4.ip_unprivileged_port_start=0 in every container; a
# Kubernetes pod keeps the kernel default 1024. Start from the pod default and
# apply the manifest's sysctls on top, so a missing sysctl fails here too.
POD_DEFAULT=(--sysctl net.ipv4.ip_unprivileged_port_start=1024)
SYSCTL_ARGS=(); while IFS= read -r kv; do [[ -n "$kv" ]] && SYSCTL_ARGS+=(--sysctl "$kv"); done < <(
  python3 -c "import json; d={'net.ipv4.ip_unprivileged_port_start': '1024'}; d.update(json.load(open('$WORK/spec.json'))['sysctls']); [print(f'{k}={v}') for k,v in d.items()]")
ENV_ARGS=(); while IFS= read -r kv; do [[ -n "$kv" ]] && ENV_ARGS+=(-e "$kv"); done < <(
  python3 -c "import json; [print(f'{k}={v}') for k,v in json.load(open('$WORK/spec.json'))['env'].items()]")

# ── 1. init container: capability-free copy ───────────────────────────────
echo "1. stalwart-binary init container"
mapfile -t INIT < <(python3 -c "import json; [print(x) for x in json.load(open('$WORK/spec.json'))['init_cmd']]" | sed -n '1,2p')
INIT_SCRIPT=$(python3 -c "import json; print(json.load(open('$WORK/spec.json'))['init_cmd'][2])")
INIT_MOUNT=$(J "['init_mount']")
out=$(docker run --rm -v "$ID-bin:$INIT_MOUNT" --entrypoint "${INIT[0]}" "$IMAGE" "${INIT[1]}" "$INIT_SCRIPT" 2>&1); rc=$?
check "init script exits 0" 0 "$rc"; [[ $rc -ne 0 ]] && echo "$out" | sed 's/^/    /'
caps=$(docker run --rm -v "$ID-bin:$BIN:ro" --entrypoint sh "$IMAGE" -c "getcap '$COPY'; test -x '$COPY' && echo exec-ok" 2>&1)
check "copy is executable" "exec-ok" "$(echo "$caps" | grep -o exec-ok)"
check "copy has no file capability" "" "$(echo "$caps" | grep -o 'cap_[a-z_]*' | head -1)"
orig=$(docker run --rm --entrypoint getcap "$IMAGE" /usr/local/bin/stalwart 2>&1)
[[ "$orig" == *cap_net_bind_service* ]] \
  && ok "image binary still carries cap_net_bind_service (why the copy exists)" \
  || echo "  note: image binary has no file capability any more ($orig) — the copy is harmless but no longer needed"

# ── 2./3. launcher: start from the copy, inspect the live process ──────────
echo "2. launcher starts Stalwart"
# The launcher script is multi-line: pass the argv elements NUL-separated, exactly.
mapfile -d '' -t ARGV < <(python3 -c "import json,sys; sys.stdout.write('\0'.join(json.load(open('$WORK/spec.json'))['argv']))")
docker run -d --name "$ID-run" "${SYSCTL_ARGS[@]}" "${ENV_ARGS[@]}" \
  -v "$ID-bin:$BIN:ro" -v "$ID-cfg:$CFG:ro" -v "$ID-data:$DATA" \
  --entrypoint "$(J "['entrypoint']")" "$IMAGE" "${ARGV[@]}" >/dev/null || { bad "container did not start"; exit 1; }
healthy=""
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$ID-run" 2>/dev/null)" == true ]] || break
  if [[ "$(docker exec "$ID-run" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz/live 2>/dev/null)" == 200 ]]; then healthy=1; break; fi
  sleep 1
done
check "Stalwart answers /healthz/live" 1 "${healthy:-0}"
[[ -z "$healthy" ]] && docker logs "$ID-run" 2>&1 | tail -15 | sed 's/^/    /'

echo "3. the running process"
if [[ -n "$healthy" ]]; then
  check "process runs the capability-free copy" "$COPY" "$(docker exec "$ID-run" readlink /proc/1/exe)"
  check "transparent huge pages off for the process" "0" \
    "$(docker exec "$ID-run" awk '/^THP_enabled:/{print $2}' /proc/1/status)"
  check "not in glibc secure mode (AT_SECURE)" "0" "$(docker exec "$ID-run" perl -e '
    open my $f, "<", "/proc/1/auxv" or die; local $/; my $d = <$f>;
    for (my $i = 0; $i < length $d; $i += 16) { my ($t, $v) = unpack "QQ", substr($d, $i, 16); print $v if $t == 23 }')"
  want_arena=$(J "['env'].get('MALLOC_ARENA_MAX', '')")
  check "MALLOC_ARENA_MAX reaches the process" "MALLOC_ARENA_MAX=$want_arena" \
    "$(docker exec "$ID-run" sh -c "tr '\0' '\n' < /proc/1/environ | grep '^MALLOC_ARENA_MAX='")"
  check "no launcher warning in the log" "" "$(docker logs "$ID-run" 2>&1 | grep -m1 'stalwart-launcher:')"
fi

# ── 4. low ports without a capability ──────────────────────────────────────
echo "4. mail ports without cap_net_bind_service"
BIND='use IO::Socket::INET; my $s = IO::Socket::INET->new(LocalAddr => "0.0.0.0", LocalPort => 25, Listen => 1, ReuseAddr => 1); print $s ? "bound" : "refused"'
check "image user binds :25 with the manifest's sysctls" "bound" \
  "$(docker run --rm "${SYSCTL_ARGS[@]}" --cap-drop ALL --entrypoint perl "$IMAGE" -e "$BIND" 2>/dev/null)"
check "control: with the pod default (1024) it is refused" "refused" \
  "$(docker run --rm "${POD_DEFAULT[@]}" --cap-drop ALL --entrypoint perl "$IMAGE" -e "$BIND" 2>/dev/null)"

echo
echo "test-stalwart-launcher: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
