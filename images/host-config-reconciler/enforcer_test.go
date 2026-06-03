package main

import (
	"os"
	"path/filepath"
	"testing"
)

// fixedNow is shared with collector_test.go (same package).

// fakeIO records every write so tests can assert the never-write-not-allowed
// invariant. reads come from a seeded map.
type fakeIO struct {
	values map[string]string
	writes []writeCall
	failOn map[string]bool // keys whose write returns an error
}

type writeCall struct{ key, value string }

func newFakeIO(seed map[string]string) *fakeIO {
	return &fakeIO{values: seed, failOn: map[string]bool{}}
}

func (f *fakeIO) read(key string) (string, bool) {
	v, ok := f.values[key]
	return normalizeSysctl(v), ok
}

func (f *fakeIO) write(key, value string) error {
	f.writes = append(f.writes, writeCall{key, value})
	if f.failOn[key] {
		return os.ErrPermission
	}
	f.values[key] = value
	return nil
}

func (f *fakeIO) wroteKey(key string) bool {
	for _, w := range f.writes {
		if w.key == key {
			return true
		}
	}
	return false
}

func desiredOf(pairs ...[2]string) *DesiredConfig {
	cfg := &DesiredConfig{}
	for _, p := range pairs {
		cfg.Sysctls = append(cfg.Sysctls, DesiredSysctl{Key: p[0], Value: p[1]})
	}
	return cfg
}

func itemFor(snap AppliedSnapshot, key string) (AppliedItem, bool) {
	for _, it := range snap.Items {
		if it.Key == key {
			return it, true
		}
	}
	return AppliedItem{}, false
}

func TestConverge_AppliesDriftingAllowedSysctls(t *testing.T) {
	io := newFakeIO(map[string]string{
		"vm.max_map_count":   "65530",  // drift → should be written
		"net.core.somaxconn": "1024",   // already ok
	})
	d := desiredOf([2]string{"vm.max_map_count", "262144"}, [2]string{"net.core.somaxconn", "1024"})
	snap := converge(d, true, io, sysctlAllowed, fixedNow, "n1")

	if snap.Mode != "enforce" {
		t.Fatalf("mode=%q want enforce", snap.Mode)
	}
	if snap.AppliedCount != 1 {
		t.Fatalf("appliedCount=%d want 1", snap.AppliedCount)
	}
	if mm, _ := itemFor(snap, "vm.max_map_count"); mm.State != "applied" || mm.Actual != "262144" {
		t.Fatalf("vm.max_map_count item=%+v want applied/262144", mm)
	}
	if so, _ := itemFor(snap, "net.core.somaxconn"); so.State != "ok" {
		t.Fatalf("net.core.somaxconn item=%+v want ok", so)
	}
	if io.wroteKey("net.core.somaxconn") {
		t.Fatal("wrote an already-correct sysctl (should be a no-op)")
	}
	if io.values["vm.max_map_count"] != "262144" {
		t.Fatalf("host value=%q want 262144", io.values["vm.max_map_count"])
	}
}

func TestConverge_DryRunWritesNothing(t *testing.T) {
	io := newFakeIO(map[string]string{"vm.max_map_count": "1"})
	d := desiredOf([2]string{"vm.max_map_count", "262144"})
	snap := converge(d, false, io, sysctlAllowed, fixedNow, "n1")

	if snap.Mode != "dry-run" {
		t.Fatalf("mode=%q want dry-run", snap.Mode)
	}
	if len(io.writes) != 0 {
		t.Fatalf("dry-run wrote %d times — must write nothing", len(io.writes))
	}
	if it, _ := itemFor(snap, "vm.max_map_count"); it.State != "would-apply" {
		t.Fatalf("state=%q want would-apply", it.State)
	}
	if snap.AppliedCount != 0 {
		t.Fatalf("appliedCount=%d want 0 in dry-run", snap.AppliedCount)
	}
}

func TestConverge_NeverWritesNotAllowed(t *testing.T) {
	// THE security invariant: a non-allow-listed key (and a path-escaping one)
	// must be classified not-allowed and NEVER written, even in enforce mode.
	io := newFakeIO(map[string]string{})
	d := desiredOf(
		[2]string{"user.max_user_namespaces", "1"}, // not in the net/vm/fs/kernel allow-list
		[2]string{"../../etc/passwd", "x"},          // path traversal
		[2]string{"dev.foo.bar", "1"},               // not allow-listed
		[2]string{"kernel.core_pattern", "|/pwn"},   // DENY-LISTED (root RCE) — must never write
		[2]string{"fs.suid_dumpable", "2"},          // DENY-LISTED amplifier
	)
	snap := converge(d, true, io, sysctlAllowed, fixedNow, "n1")

	if len(io.writes) != 0 {
		t.Fatalf("converge wrote %d times for non-allow-listed keys — MUST be 0: %+v", len(io.writes), io.writes)
	}
	for _, k := range []string{"user.max_user_namespaces", "../../etc/passwd", "dev.foo.bar", "kernel.core_pattern", "fs.suid_dumpable"} {
		it, ok := itemFor(snap, k)
		if !ok || it.State != "not-allowed" {
			t.Fatalf("key %q item=%+v ok=%v want state not-allowed", k, it, ok)
		}
	}
}

// A successful write whose re-read returns a DIFFERENT value (kernel clamped /
// rejected) is still "applied" (the write syscall succeeded) but records the
// clamped actual so operators can spot desired != actual.
func TestConverge_ClampedWriteStaysApplied(t *testing.T) {
	io := &clampIO{cur: "1"} // read always returns "1" regardless of writes
	d := desiredOf([2]string{"vm.max_map_count", "262144"})
	snap := converge(d, true, io, sysctlAllowed, fixedNow, "n1")
	it, _ := itemFor(snap, "vm.max_map_count")
	if it.State != "applied" {
		t.Fatalf("state=%q want applied", it.State)
	}
	if it.Actual != "1" || it.Desired != "262144" {
		t.Fatalf("item=%+v want desired=262144 actual=1 (clamp recorded)", it)
	}
}

// clampIO accepts writes but its read always returns cur — models a kernel that
// clamps/ignores the written value.
type clampIO struct {
	cur     string
	written bool
}

func (c *clampIO) read(string) (string, bool) { return c.cur, true }
func (c *clampIO) write(string, string) error { c.written = true; return nil }

func TestRealSysctlIO_RejectsOversizeValue(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "proc", "sys", "vm", "max_map_count")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	io := newRealSysctlIO(dir)
	huge := make([]byte, maxSysctlValueLen+1)
	for i := range huge {
		huge[i] = '9'
	}
	if err := io.write("vm.max_map_count", string(huge)); err == nil {
		t.Fatal("write accepted an oversize value")
	}
	if v, _ := io.read("vm.max_map_count"); v != "1" {
		t.Fatalf("oversize write mutated the file: %q", v)
	}
}

func TestConverge_WriteFailureIsRecordedNotFatal(t *testing.T) {
	io := newFakeIO(map[string]string{"vm.max_map_count": "1", "fs.file-max": "1"})
	io.failOn["vm.max_map_count"] = true
	d := desiredOf([2]string{"vm.max_map_count", "262144"}, [2]string{"fs.file-max", "999"})
	snap := converge(d, true, io, sysctlAllowed, fixedNow, "n1")

	if it, _ := itemFor(snap, "vm.max_map_count"); it.State != "write-failed" || it.Error == "" {
		t.Fatalf("vm.max_map_count item=%+v want write-failed with error", it)
	}
	// A failure on one key must not stop the next.
	if it, _ := itemFor(snap, "fs.file-max"); it.State != "applied" {
		t.Fatalf("fs.file-max item=%+v want applied (failure of a prior key must not halt)", it)
	}
	if len(snap.Errors) != 1 {
		t.Fatalf("errors=%v want exactly 1", snap.Errors)
	}
}

func TestConverge_UnreadableAndAbsentDesired(t *testing.T) {
	io := newFakeIO(map[string]string{}) // nothing readable
	snap := converge(desiredOf([2]string{"vm.max_map_count", "1"}), true, io, sysctlAllowed, fixedNow, "n1")
	if it, _ := itemFor(snap, "vm.max_map_count"); it.State != "unreadable" {
		t.Fatalf("state=%q want unreadable", it.State)
	}
	if len(io.writes) != 0 {
		t.Fatal("wrote despite an unreadable current value")
	}

	absent := converge(nil, true, io, sysctlAllowed, fixedNow, "n1")
	if absent.DesiredSource != "absent" || len(absent.Items) != 0 {
		t.Fatalf("nil desired snap=%+v want absent/empty", absent)
	}
}

// realSysctlIO.write must be a SECOND, independent gate: even called directly
// with a non-allow-listed or path-escaping key, it writes nothing and errors.
func TestRealSysctlIO_WriteGate(t *testing.T) {
	dir := t.TempDir()
	// Lay down a fake /proc/sys with a writable allow-listed file + a file the
	// path-traversal key would target.
	must := func(p, v string) {
		full := filepath.Join(dir, "proc", "sys", p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("vm/max_map_count", "1")
	// A sentinel OUTSIDE proc/sys that a traversal must never reach.
	outside := filepath.Join(dir, "etc_passwd")
	if err := os.WriteFile(outside, []byte("ORIGINAL"), 0o644); err != nil {
		t.Fatal(err)
	}

	io := newRealSysctlIO(dir)

	// allow-listed write succeeds + actually changes the file
	if err := io.write("vm.max_map_count", "262144"); err != nil {
		t.Fatalf("allow-listed write errored: %v", err)
	}
	if v, _ := io.read("vm.max_map_count"); v != "262144" {
		t.Fatalf("post-write read=%q want 262144", v)
	}

	// non-allow-listed → refused
	if err := io.write("user.max_user_namespaces", "1"); err == nil {
		t.Fatal("realSysctlIO.write accepted a non-allow-listed key")
	}
	// path traversal → refused (and the outside sentinel is untouched)
	if err := io.write("../../etc_passwd", "PWNED"); err == nil {
		t.Fatal("realSysctlIO.write accepted a path-traversal key")
	}
	if b, _ := os.ReadFile(outside); string(b) != "ORIGINAL" {
		t.Fatalf("path traversal mutated a file outside /proc/sys: %q", b)
	}
}
