package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Unix(1700000000, 0).UTC() }

func writeSysctl(t *testing.T, root, key, val string) {
	t.Helper()
	rel, ok := sysctlKeyToPath(key)
	if !ok {
		t.Fatalf("bad key %q", key)
	}
	p := filepath.Join(root, "proc", "sys", rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(val), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCollectClassifiesStates(t *testing.T) {
	root := t.TempDir()
	writeSysctl(t, root, "net.ipv4.ip_forward", "1\n")
	writeSysctl(t, root, "vm.max_map_count", "65530\n") // differs from desired

	c := &collector{hostRoot: root, nodeName: "n1", now: fixedNow, allow: sysctlAllowed}
	desired := &DesiredConfig{Sysctls: []DesiredSysctl{
		{"net.ipv4.ip_forward", "1"},      // ok
		{"vm.max_map_count", "262144"},    // drift (actual 65530)
		{"fs.file-max", "9999"},           // unreadable (no file)
		{"user.max_user_namespaces", "0"}, // not-allowed (outside allow-list)
	}}
	snap := c.collect(desired)

	if snap.DesiredSource != "configmap" {
		t.Errorf("source=%q want configmap", snap.DesiredSource)
	}
	if snap.Mode != "observe" {
		t.Errorf("mode=%q want observe", snap.Mode)
	}
	if snap.DriftCount != 1 {
		t.Errorf("driftCount=%d want 1", snap.DriftCount)
	}
	want := map[string]string{
		"net.ipv4.ip_forward":      "ok",
		"vm.max_map_count":         "drift",
		"fs.file-max":              "unreadable",
		"user.max_user_namespaces": "not-allowed",
	}
	if len(snap.Sysctls) != len(want) {
		t.Fatalf("got %d items want %d", len(snap.Sysctls), len(want))
	}
	for _, it := range snap.Sysctls {
		if want[it.Key] != it.State {
			t.Errorf("%s state=%q want %q", it.Key, it.State, want[it.Key])
		}
	}
	// not-allowed must NOT have been read from disk (Actual stays empty).
	for _, it := range snap.Sysctls {
		if it.State == "not-allowed" && it.Actual != "" {
			t.Errorf("not-allowed key %s leaked Actual=%q", it.Key, it.Actual)
		}
	}
}

func TestCollectNilDesired(t *testing.T) {
	c := newCollector(t.TempDir(), "n1")
	snap := c.collect(nil)
	if snap.DesiredSource != "absent" {
		t.Errorf("source=%q want absent", snap.DesiredSource)
	}
	if len(snap.Sysctls) != 0 || snap.DriftCount != 0 {
		t.Errorf("nil desired → sysctls=%d drift=%d", len(snap.Sysctls), snap.DriftCount)
	}
}

func TestCollectWhitespaceNormalized(t *testing.T) {
	root := t.TempDir()
	// tcp_rmem-style tab-separated triple.
	writeSysctl(t, root, "net.ipv4.tcp_rmem", "4096\t131072\t6291456\n")
	c := &collector{hostRoot: root, nodeName: "n", now: fixedNow, allow: sysctlAllowed}
	snap := c.collect(&DesiredConfig{Sysctls: []DesiredSysctl{{"net.ipv4.tcp_rmem", "4096 131072 6291456"}}})
	if snap.Sysctls[0].State != "ok" {
		t.Errorf("tcp_rmem state=%q want ok (whitespace-normalized)", snap.Sysctls[0].State)
	}
}

func TestReadActualSysctlAbsentIsUnreadable(t *testing.T) {
	c := newCollector(t.TempDir(), "n")
	if v, ok := c.readActualSysctl("net.ipv4.ip_forward"); ok {
		t.Errorf("expected unreadable (file absent), got %q", v)
	}
}
