package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The probe reads the host through an allowlist of read-only mounts. A path the
// code reads but the DaemonSet does not mount is INVISIBLE — not an error, just
// permanently absent — so the check that depends on it reports a plausible
// false on every node and nobody can tell it apart from a real finding.
//
// This is how the HARDEN-002 rewrite first shipped: the logic was right, 13
// hermetic tests passed, and on DEV it reported false on a node that was in fact
// fully configured, because apt.conf.d and timers.target.wants were not mounted.
// Hermetic tests build their own root, so they can never catch this class.
//
// Asserting the code's declared path list against the committed manifest does.
func TestDaemonSetMountsEveryPathTheAutoUpdateCheckReads(t *testing.T) {
	manifest := filepath.Join("..", "..", "k8s", "base", "security-probe", "daemonset.yaml")
	b, err := os.ReadFile(manifest)
	if err != nil {
		// Deliberately fatal rather than t.Skip: a skip here would make this
		// guard vacuous exactly when the manifest moves, which is precisely
		// when the mounts are most likely to drift.
		t.Fatalf("cannot read %s: %v — if the manifest moved, update this test, do not delete it", manifest, err)
	}
	yaml := string(b)

	var missing []string
	for _, p := range hostPathsReadByHardeningChecks {
		want := "mountPath: /host/" + p
		if !strings.Contains(yaml, want) {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("host path(s) read by a hardening check but NOT mounted by the DaemonSet: %v\n"+
			"Each one reads as absent in the container, so the check reports false on every node.\n"+
			"Add a readOnly hostPath mount at /host/<path> (type: DirectoryOrCreate — the path is\n"+
			"per-distro and `Directory` would crashloop the DaemonSet on the other half of the matrix).",
			missing)
	}
}

// Non-vacuity: if the declared list were ever emptied, the loop above would pass
// trivially. Pin that it actually covers the paths the apt and dnf branches use.
func TestAutoUpdatePathListIsNotEmpty(t *testing.T) {
	if len(hostPathsReadByHardeningChecks) == 0 {
		t.Fatal("hostPathsReadByHardeningChecks is empty — the mount guard would pass trivially")
	}
	for _, needed := range []string{"etc/apt/apt.conf.d", "etc/systemd/system/timers.target.wants"} {
		found := false
		for _, p := range hostPathsReadByHardeningChecks {
			if p == needed {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s is read by a hardening check but missing from hostPathsReadByHardeningChecks", needed)
		}
	}
}

// firewall.conf: the code reads every path in firewallConfPaths; each must be
// mounted (the directory for the new location, the single file for the old).
func TestDaemonSetMountsEveryFirewallConfPath(t *testing.T) {
	yaml := readProbeManifest(t)
	for _, rel := range firewallConfPaths {
		mount := "/host/" + rel
		if strings.HasSuffix(rel, "/firewall/firewall.conf") {
			mount = "/host/" + filepath.Dir(rel)
		}
		if !strings.Contains(yaml, "mountPath: "+mount+"\n") {
			t.Errorf("firewall.conf path %q is read by the probe but %q is not mounted", rel, mount)
		}
	}
}

// The probe must never mount a whole platform root. /etc/hosting-platform and
// /etc/platform are symlinks to /etc/insula, which holds the platform's
// credential files; /var/lib/{platform,hosting-platform} are /var/lib/insula,
// which holds the operator key and the secrets bundles. Mounting one of those
// roots — even read-only, even with every capability dropped — hands the
// probe's uid 0 the files. This is how 2026.10.6 and earlier shipped.
func TestDaemonSetMountsNoPlatformRoot(t *testing.T) {
	yaml := readProbeManifest(t)
	for _, root := range []string{
		"/etc/insula", "/etc/platform", "/etc/hosting-platform",
		"/var/lib/insula", "/var/lib/platform", "/var/lib/hosting-platform",
	} {
		// Block style (`path: /etc/insula`) and flow style
		// (`hostPath: {path: /etc/insula, type: Directory}`).
		re := regexp.MustCompile(`(^|[{,])\s*path:\s*["']?` + regexp.QuoteMeta(root) + `/?["']?\s*([,}#]|$)`)
		for _, line := range strings.Split(yaml, "\n") {
			if re.MatchString(strings.TrimSpace(line)) {
				t.Errorf("security-probe mounts the platform root %s — mount the one file or subdirectory it reads", root)
			}
		}
	}
}

func readProbeManifest(t *testing.T) string {
	t.Helper()
	manifest := filepath.Join("..", "..", "k8s", "base", "security-probe", "daemonset.yaml")
	b, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatalf("cannot read %s: %v — if the manifest moved, update this test, do not delete it", manifest, err)
	}
	return string(b)
}

// A hostPath of /proc/net/nf_conntrack cannot be mounted on a kernel without
// CONFIG_NF_CONNTRACK_PROCFS: kubelet's FileOrCreate tries to create the file in
// procfs, fails, and the pod sits in ContainerCreating forever (seen on an Ubuntu
// 24.04 node). The probe reads the table from its own procfs (hostNetwork), so the
// mount must not come back.
func TestDaemonSetDoesNotHostMountTheConntrackTable(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "k8s", "base", "security-probe", "daemonset.yaml"))
	if err != nil {
		t.Fatalf("cannot read the DaemonSet manifest: %v", err)
	}
	if strings.Contains(string(b), "path: /proc/net/nf_conntrack") {
		t.Fatal("the DaemonSet host-mounts /proc/net/nf_conntrack again — it blocks the pod on kernels without the procfs table")
	}
}
