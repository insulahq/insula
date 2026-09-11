package main

import (
	"os"
	"path/filepath"
	"testing"
)

// installedKernel creates a modules tree that looks like an INSTALLED kernel:
// the kernel/ subdirectory is what distinguishes it from a removed one.
func installedKernel(t *testing.T, root, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "usr/lib/modules", version, "kernel"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "usr/lib/modules", version, "modules.dep"), nil, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// removedKernel reproduces what `apt autoremove` leaves behind: modules.dep
// survives, kernel/ does not. Measured on the production node — the auto-removed
// 6.12.94 tree still had modules.dep.
func removedKernel(t *testing.T, root, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "usr/lib/modules", version), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "usr/lib/modules", version, "modules.dep"), nil, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func runningKernel(t *testing.T, root, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "proc/sys/kernel"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "proc/sys/kernel/osrelease"), []byte(version+"\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// The production state after the 2026-09-11 security upgrades: running 6.12.101,
// 6.12.107 installed, reboot pending. KERNEL-002 was permanently green here.
func TestPendingKernelUpdate_ProductionShape(t *testing.T) {
	root := t.TempDir()
	runningKernel(t, root, "6.12.101+deb13-amd64")
	installedKernel(t, root, "6.12.101+deb13-amd64")
	installedKernel(t, root, "6.12.107+deb13-amd64")
	removedKernel(t, root, "6.12.94+deb13-amd64")
	if !pendingKernelUpdate(root) {
		t.Fatal("6.12.107 installed while running 6.12.101 — a reboot WOULD change the kernel")
	}
}

func TestPendingKernelUpdate_UpToDate(t *testing.T) {
	root := t.TempDir()
	runningKernel(t, root, "6.12.107+deb13-amd64")
	installedKernel(t, root, "6.12.107+deb13-amd64")
	removedKernel(t, root, "6.12.94+deb13-amd64")
	if pendingKernelUpdate(root) {
		t.Fatal("running the newest installed kernel — nothing pending")
	}
}

// A leftover modules tree from a REMOVED kernel must not count as installed.
// Keying on modules.dep alone would report a pending update for a kernel that
// is not on the system at all.
func TestPendingKernelUpdate_RemovedKernelDoesNotCount(t *testing.T) {
	root := t.TempDir()
	runningKernel(t, root, "6.12.101+deb13-amd64")
	installedKernel(t, root, "6.12.101+deb13-amd64")
	removedKernel(t, root, "6.12.199+deb13-amd64") // newer, but gone
	if pendingKernelUpdate(root) {
		t.Fatal("6.12.199 was removed (no kernel/ subdir) — must not report pending")
	}
}

// The comparison that a plain string compare gets BACKWARDS.
func TestCompareVersionStrings_NumericNotLexical(t *testing.T) {
	if compareVersionStrings("6.12.101+deb13-amd64", "6.12.99+deb13-amd64") <= 0 {
		t.Fatal("6.12.101 must sort ABOVE 6.12.99 — string compare says otherwise")
	}
	if compareVersionStrings("6.12.99+deb13-amd64", "6.12.101+deb13-amd64") >= 0 {
		t.Fatal("6.12.99 must sort BELOW 6.12.101")
	}
	if compareVersionStrings("6.12.107+deb13-amd64", "6.12.107+deb13-amd64") != 0 {
		t.Fatal("identical releases must compare equal")
	}
	if compareVersionStrings("6.13.0+deb13-amd64", "6.12.999+deb13-amd64") <= 0 {
		t.Fatal("minor version outranks patch")
	}
}

// RHEL-family release strings must order correctly too.
func TestCompareVersionStrings_RHELShape(t *testing.T) {
	if compareVersionStrings("5.14.0-503.el9.x86_64", "5.14.0-70.el9.x86_64") <= 0 {
		t.Fatal("503 must sort above 70")
	}
}

// Release strings taken from a real kernel package installed in each supported
// OS image on 2026-09-11, not invented. Every one of these hosts puts the tree
// at /usr/lib/modules/<ver>/kernel with /lib/modules symlinked to it, which is
// the layout newestInstalledKernel depends on.
func TestCompareVersionStrings_RealReleasesFromEverySupportedOS(t *testing.T) {
	for _, tc := range []struct{ os, older, newer string }{
		{"Debian 12", "6.1.0-53-amd64", "6.1.0-54-amd64"},
		{"Debian 13", "6.12.101+deb13-amd64", "6.12.107+deb13-amd64"},
		{"Ubuntu 22.04", "5.15.0-191-generic", "5.15.0-192-generic"},
		{"Ubuntu 24.04", "6.8.0-139-generic", "6.8.0-140-generic"},
		{"Rocky 9", "5.14.0-687.44.1.el9_8.x86_64", "5.14.0-687.46.1.el9_8.x86_64"},
		{"AlmaLinux 9", "5.14.0-687.44.1.el9_8.x86_64", "5.14.0-687.46.1.el9_8.x86_64"},
		{"CentOS Stream 9", "5.14.0-70.el9.x86_64", "5.14.0-742.el9.x86_64"},
		{"Amazon Linux 2023", "6.1.180-225.360.amzn2023.x86_64", "6.1.181-225.360.amzn2023.x86_64"},
	} {
		if compareVersionStrings(tc.newer, tc.older) <= 0 {
			t.Errorf("%s: %q must sort ABOVE %q", tc.os, tc.newer, tc.older)
		}
		if compareVersionStrings(tc.older, tc.newer) >= 0 {
			t.Errorf("%s: %q must sort BELOW %q", tc.os, tc.older, tc.newer)
		}
		if compareVersionStrings(tc.newer, tc.newer) != 0 {
			t.Errorf("%s: %q must equal itself", tc.os, tc.newer)
		}
	}
}

func TestPendingKernelUpdate_NumericPointReleaseIsNotLexical(t *testing.T) {
	root := t.TempDir()
	runningKernel(t, root, "6.12.99+deb13-amd64")
	installedKernel(t, root, "6.12.99+deb13-amd64")
	installedKernel(t, root, "6.12.101+deb13-amd64")
	if !pendingKernelUpdate(root) {
		t.Fatal("6.12.101 > 6.12.99 numerically — a lexical compare would miss this")
	}
}

// Missing inputs must not manufacture a finding.
func TestPendingKernelUpdate_MissingInputs(t *testing.T) {
	if pendingKernelUpdate(t.TempDir()) {
		t.Fatal("empty host root must not report a pending kernel update")
	}
	root := t.TempDir()
	runningKernel(t, root, "6.12.101+deb13-amd64")
	if pendingKernelUpdate(root) {
		t.Fatal("no modules directory (unmounted) must not report pending — that would be a finding on every node")
	}
}

// KERNEL-002 must actually reflect the field now that it is computed.
func TestCISFinding_KERNEL002_ReflectsPendingUpdate(t *testing.T) {
	ssh := sshView("no", "no", "no", []string{"admin"}, true)
	for _, tc := range []struct {
		pending bool
		passing bool
	}{{false, true}, {true, false}} {
		h := Hardening{TimeSinceRebootSecs: 1000, Fail2banPresent: true, PendingKernelUpdate: tc.pending}
		findings := buildCISFindings(ssh, h, false)
		var f *CISFinding
		for i := range findings {
			if findings[i].ID == "KERNEL-002" {
				f = &findings[i]
				break
			}
		}
		if f == nil {
			t.Fatal("KERNEL-002 missing")
		}
		if f.Passing != tc.passing {
			t.Fatalf("pending=%v: want passing=%v got %v", tc.pending, tc.passing, f.Passing)
		}
	}
}
