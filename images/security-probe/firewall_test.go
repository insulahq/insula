package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFirewallConf(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/hosting-platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/hosting-platform/firewall.conf"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestReadFirewallConf_SSHPublicByDefault(t *testing.T) {
	root := t.TempDir() // no firewall.conf at all
	fw := readFirewallConf(root)
	if fw.loaded {
		t.Errorf("loaded should be false")
	}
	if !fw.ssh22IsPublic {
		t.Errorf("with no firewall.conf SSH must be reported as public")
	}
	if fw.sshViaMesh {
		t.Errorf("sshViaMesh should be false by default")
	}
}

func TestReadFirewallConf_SSHViaMesh(t *testing.T) {
	root := writeFirewallConf(t, `
PUBLIC_TCP_PORTS=80 443 8443 6443
PUBLIC_UDP_PORTS=51820 51821
SSH_VIA_MESH=true
SSH_VIA_MESH_INTERFACE=wt0
`)
	fw := readFirewallConf(root)
	if !fw.loaded {
		t.Errorf("loaded should be true")
	}
	if !fw.sshViaMesh {
		t.Errorf("sshViaMesh should be true")
	}
	if fw.sshViaMeshInterface == nil || *fw.sshViaMeshInterface != "wt0" {
		t.Errorf("interface=%v want wt0", fw.sshViaMeshInterface)
	}
	if fw.ssh22IsPublic {
		t.Errorf("with SSH_VIA_MESH=true and 22 not in PUBLIC_TCP_PORTS, SSH should NOT be public")
	}
	mode := classifySSHRestriction(fw)
	if mode != "mesh-and-trusted" {
		t.Errorf("classification=%s want mesh-and-trusted", mode)
	}
}

func TestReadFirewallConf_SSHViaMeshButPort22StillPublic(t *testing.T) {
	// Defensive: an operator-edited firewall.conf could declare 22
	// public even with SSH_VIA_MESH=true. The probe should report
	// the truth (public) and let the UI flag the contradiction.
	root := writeFirewallConf(t, `
PUBLIC_TCP_PORTS=22 80 443
SSH_VIA_MESH=true
SSH_VIA_MESH_INTERFACE=wt0
`)
	fw := readFirewallConf(root)
	if !fw.ssh22IsPublic {
		t.Errorf("operator listed 22 publicly — must report public regardless of SSH_VIA_MESH flag")
	}
}

func TestParsePortList_CommaAndSpaceMix(t *testing.T) {
	in := "80,443 8080  3000,3001"
	want := []int{80, 443, 8080, 3000, 3001}
	got := parsePortList(in)
	if len(got) != len(want) {
		t.Fatalf("len=%d want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got[%d]=%d want %d", i, got[i], want[i])
		}
	}
}

func TestParsePortList_RejectsInvalidPorts(t *testing.T) {
	// 0, 65536, negative, non-numeric — all dropped.
	in := "0 22 65535 65536 abc -1"
	got := parsePortList(in)
	want := []int{22, 65535}
	if len(got) != len(want) {
		t.Fatalf("got=%v want %v", got, want)
	}
}

// writeFirewallConfAt writes body at <root>/<rel>, creating parents.
func writeFirewallConfAt(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Since 2026.10.7 the file lives in a directory of its own (the probe mounts
// only that directory). When both copies are visible the new one is the truth.
func TestReadFirewallConf_PrefersItsOwnDirectory(t *testing.T) {
	root := t.TempDir()
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall.conf",
		"PUBLIC_TCP_PORTS=80 443 22\nSSH_VIA_MESH=false\n")
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall/firewall.conf",
		"PUBLIC_TCP_PORTS=80 443\nSSH_VIA_MESH=true\nSSH_VIA_MESH_INTERFACE=wt0\n")
	fw := readFirewallConf(root)
	if !fw.loaded || !fw.sshViaMesh || fw.ssh22IsPublic {
		t.Fatalf("want the new-path posture (mesh-only SSH), got %+v", fw)
	}
}

// A node that has not run host-migration 2026.10.7/0001 yet still has the file
// at the old path; the DaemonSet mounts that single file as a fallback.
func TestReadFirewallConf_FallsBackToTheOldPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/hosting-platform/firewall"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall.conf",
		"PUBLIC_TCP_PORTS=80 443\nSSH_VIA_MESH=true\nSSH_VIA_MESH_INTERFACE=wt0\n")
	fw := readFirewallConf(root)
	if !fw.loaded || !fw.sshViaMesh || fw.ssh22IsPublic {
		t.Fatalf("want the old-path posture, got %+v", fw)
	}
}

// The kubelet creates an EMPTY file for a hostPath FileOrCreate mount whose
// source is missing. That must read as "not present", not as a node that
// declares no public ports at all.
func TestReadFirewallConf_AnEmptyFileIsNotAPosture(t *testing.T) {
	root := t.TempDir()
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall/firewall.conf", "")
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall.conf", "# only a comment\n\n")
	fw := readFirewallConf(root)
	if fw.loaded {
		t.Fatalf("an empty/comment-only file must not count as loaded, got %+v", fw)
	}
	if !fw.ssh22IsPublic {
		t.Fatal("with no posture on record SSH must be assumed public")
	}
}

// An empty file in the new directory must not hide a real one at the old path.
func TestReadFirewallConf_EmptyNewFileFallsThroughToOld(t *testing.T) {
	root := t.TempDir()
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall/firewall.conf", "")
	writeFirewallConfAt(t, root, "etc/hosting-platform/firewall.conf",
		"PUBLIC_TCP_PORTS=80 443\nSSH_VIA_MESH=true\n")
	fw := readFirewallConf(root)
	if !fw.loaded || !fw.sshViaMesh {
		t.Fatalf("want the old file's posture, got %+v", fw)
	}
}
