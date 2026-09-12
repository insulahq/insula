package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The bug this guards, measured on staging 2026-09-12:
//
// nftables restores the set DECLARATIONS at boot, but set members are runtime
// state and a reboot discards them. cluster_peers_v{4,6} gates inbound
// etcd/apiserver/kubelet traffic under a `policy drop` chain, so an empty set
// after a reboot means no peer can reach the node. etcd reported "failed to
// publish local member to cluster through raft" and the node never rejoined.
//
// It deadlocks: the only thing that fills the set is this reconciler, a
// DaemonSet running INSIDE the cluster the node can no longer join. A rebooted
// server sat NotReady for 19 minutes, untouched by the hourly host-config
// converger, and rejoined 21 seconds after the members were restored by hand.

func readPersisted(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted file: %v", err)
	}
	return string(b)
}

func TestPersistPeerSetsWritesReplayableElements(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "10-cluster-peers.conf")
	err := persistPeerSets(path, peerNftSets{
		PeersV4:   []string{"10.0.0.2", "10.0.0.1"},
		PeersV6:   []string{"2001:db8::1"},
		TrustedV4: []string{"192.0.2.0/24"},
		TrustedV6: []string{"2001:db8:1::/48"},
	})
	if err != nil {
		t.Fatalf("persistPeerSets: %v", err)
	}

	got := readPersisted(t, path)
	// Must be an nft script `nft -f` can replay verbatim at boot.
	for _, want := range []string{
		"add element inet filter cluster_peers_v4 { 10.0.0.1, 10.0.0.2 }",
		"add element inet filter cluster_peers_v6 { 2001:db8::1 }",
		"add element inet filter trusted_ranges_v4 { 192.0.2.0/24 }",
		"add element inet filter trusted_ranges_v6 { 2001:db8:1::/48 }",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("persisted file missing %q\ngot:\n%s", want, got)
		}
	}
}

func TestPersistPeerSetsIsDeterministic(t *testing.T) {
	// Same members in a different order must produce identical bytes, or every
	// reconcile rewrites the file and churns disk for nothing.
	dir := t.TempDir()
	a := filepath.Join(dir, "a.conf")
	b := filepath.Join(dir, "b.conf")
	if err := persistPeerSets(a, peerNftSets{PeersV4: []string{"10.0.0.3", "10.0.0.1", "10.0.0.2"}}); err != nil {
		t.Fatalf("persist a: %v", err)
	}
	if err := persistPeerSets(b, peerNftSets{PeersV4: []string{"10.0.0.2", "10.0.0.3", "10.0.0.1"}}); err != nil {
		t.Fatalf("persist b: %v", err)
	}
	if readPersisted(t, a) != readPersisted(t, b) {
		t.Errorf("output depends on input order:\nA:\n%s\nB:\n%s", readPersisted(t, a), readPersisted(t, b))
	}
}

func TestPersistPeerSetsOmitsEmptySets(t *testing.T) {
	// `add element … { }` is a syntax error, which would make nftables fail to
	// load at boot — strictly worse than the bug being fixed.
	path := filepath.Join(t.TempDir(), "peers.conf")
	if err := persistPeerSets(path, peerNftSets{PeersV4: []string{"10.0.0.1"}}); err != nil {
		t.Fatalf("persistPeerSets: %v", err)
	}
	got := readPersisted(t, path)
	if strings.Contains(got, "{  }") || strings.Contains(got, "{ }") {
		t.Errorf("emitted an empty element list:\n%s", got)
	}
	for _, absent := range []string{setPeersV6, setTrustedV4, setTrustedV6} {
		if strings.Contains(got, absent) {
			t.Errorf("named %s despite having no members:\n%s", absent, got)
		}
	}
}

func TestPersistPeerSetsWithNoMembersAtAllIsStillValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.conf")
	if err := persistPeerSets(path, peerNftSets{}); err != nil {
		t.Fatalf("persistPeerSets: %v", err)
	}
	got := readPersisted(t, path)
	if strings.Contains(got, "add element") {
		t.Errorf("emitted an element line with no members:\n%s", got)
	}
	// Comment-only is a valid nft include.
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			t.Errorf("unexpected non-comment line %q", line)
		}
	}
}

func TestPersistPeerSetsReplacesPreviousContent(t *testing.T) {
	// A departed peer must not linger in the boot-restore file.
	path := filepath.Join(t.TempDir(), "peers.conf")
	if err := persistPeerSets(path, peerNftSets{PeersV4: []string{"10.0.0.1", "10.0.0.9"}}); err != nil {
		t.Fatalf("persist first: %v", err)
	}
	if err := persistPeerSets(path, peerNftSets{PeersV4: []string{"10.0.0.1"}}); err != nil {
		t.Fatalf("persist second: %v", err)
	}
	if got := readPersisted(t, path); strings.Contains(got, "10.0.0.9") {
		t.Errorf("removed peer still present after rewrite:\n%s", got)
	}
}

func TestPersistPeerSetsLeavesNoTempFile(t *testing.T) {
	// Written via write-then-rename; a stray .tmp would be picked up by the
	// *.conf glob only if misnamed, but a leak is still a bug.
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	if err := persistPeerSets(path, peerNftSets{PeersV4: []string{"10.0.0.1"}}); err != nil {
		t.Fatalf("persistPeerSets: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("left a temp file behind: %s", e.Name())
		}
	}
}

func TestPeerPersistPathIsInsideTheIncludedDirectory(t *testing.T) {
	// bootstrap.sh writes `include "/etc/nftables.d/*.conf"`. A path outside
	// that directory, or without the .conf suffix, is never replayed at boot
	// and the fix silently does nothing.
	if dir := filepath.Dir(peerPersistPath); dir != "/etc/nftables.d" {
		t.Errorf("peerPersistPath dir = %q, want /etc/nftables.d", dir)
	}
	if filepath.Ext(peerPersistPath) != ".conf" {
		t.Errorf("peerPersistPath = %q, want a .conf suffix", peerPersistPath)
	}
}
