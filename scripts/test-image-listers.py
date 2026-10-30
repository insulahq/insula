#!/usr/bin/env python3
"""Tests for the image listers the scan and the registry read (offline).

scripts/lib/config-images.py (images held as data in k8s/base) and
scripts/lib/script-images.py's `# superseded-images:` header. Plain python, like
scripts/test-trivy-helpers.py. Run: python3 scripts/test-image-listers.py
"""
import base64
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "lib", filename))
    mod = importlib.util.module_from_spec(spec)
    sys.argv = [filename]  # the modules read argv[1] as the repo root at import
    spec.loader.exec_module(mod)
    return mod


cfg = load("config_images", "config-images.py")
scr = load("script_images", "script-images.py")
failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        failures.append(name)


# ── config-images: data fields that hold an image ──
cluster = {"apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster",
           "spec": {"imageName": "ghcr.io/cloudnative-pg/postgresql:18.6-202610260820-minimal-trixie"}}
check("a CNPG Cluster's imageName", cfg.images_in_doc(cluster) == [cluster["spec"]["imageName"]])
check("imageName of another kind is ignored",
      cfg.images_in_doc({"apiVersion": "x/v1", "kind": "Cluster", "spec": {"imageName": "a/b:1"}}) == [])
cm = {"kind": "ConfigMap", "data": {
    "SYSTEM_UPGRADE_JOB_KUBECTL_IMAGE": "rancher/kubectl:v1.36.2",
    "SYSTEM_UPGRADE_JOB_KUBECTL_IMAGE_WINDOWS": "",
    "private-worker-frps-image": "fatedier/frps:v0.71.1",
    "file-manager-image": "ghcr.io/insulahq/insula/file-manager:latest",
    "bare-image": "file-manager:latest",
    "templated-image": "${REGISTRY}/x:1",
    "SOME_SETTING": "rancher/kubectl:v1.36.2",
    "untagged-image": "nginx"}}
check("ConfigMap *_IMAGE / -image values, upstream and tagged only",
      sorted(cfg.images_in_doc(cm)) == ["fatedier/frps:v0.71.1", "rancher/kubectl:v1.36.2"])
b64 = base64.b64encode(b"ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.1").decode()
secret = {"kind": "Secret", "data": {"SIDECAR_IMAGE": b64[:30] + "\n" + b64[30:], "PASSWORD": b64},
          "stringData": {"OTHER_IMAGE": "busybox:1.37"}}
check("Secret base64 *_IMAGE (wrapped) and stringData; other keys ignored",
      sorted(cfg.images_in_doc(secret)) == ["busybox:1.37", "ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.1"])
check("an undecodable value is skipped, not fatal",
      cfg.images_in_doc({"kind": "Secret", "data": {"X_IMAGE": "!!!not base64"}}) == [])

# The real tree: the platform database must always be listed (a lister that
# stops seeing it is a false green for the one image that holds all the data).
import subprocess
REPO = os.path.dirname(HERE)
out = subprocess.run([sys.executable, os.path.join(HERE, "lib", "config-images.py"), REPO],
                     capture_output=True, text=True)
check("config-images on this repo lists the CNPG database image",
      out.returncode == 0 and "ghcr.io/cloudnative-pg/postgresql:" in out.stdout)
check("config-images on this repo lists the barman sidecar (base64 Secret)",
      "plugin-barman-cloud-sidecar:" in out.stdout)

# ── script-images: a superseded image is not listed ──
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "0001-x.sh")
    with open(p, "w") as f:
        f.write("#!/usr/bin/env bash\n"
                "# superseded-images: alpine/k8s:1.33.13 (2026.10.23/0004 replaces it)\n"
                "set -euo pipefail\n"
                '"image": "alpine/k8s:1.33.13",\n'
                "      image: curlimages/curl:8.23.0\n")
    got = scr.images_in(p)
    check("superseded: the header's image is left out, others stay", got == ["curlimages/curl:8.23.0"])
    with open(p, "w") as f:
        f.write('"image": "alpine/k8s:1.33.13",\n')
    check("without the header the image is listed", scr.images_in(p) == ["alpine/k8s:1.33.13"])

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all image-lister tests passed")
