package main

import (
	"os"
	"path/filepath"
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
