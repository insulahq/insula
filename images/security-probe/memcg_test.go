package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// fakeClock is a settable clock; the witness reads it under its own lock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// Container ids are 64 hex characters, as containerd mints them.
var (
	ctrApp     = strings.Repeat("a1", 32)
	ctrSidecar = strings.Repeat("b2", 32)
)

const (
	uidA = "0a1b2c3d-0000-4000-8000-00000000000a"
	uidB = "0a1b2c3d-0000-4000-8000-00000000000b"
	uidC = "0a1b2c3d-0000-4000-8000-00000000000c"
)

// fakeCgroupTree builds <root>/sys/fs/cgroup with a systemd-driver kubepods
// layout and returns the host root and the burstable QoS directory.
func fakeCgroupTree(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	cg := filepath.Join(root, "sys", "fs", "cgroup")
	burst := filepath.Join(cg, "kubepods.slice", "kubepods-burstable.slice")
	if err := os.MkdirAll(burst, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(cg, "cgroup.controllers"), "cpu memory pids\n")
	return root, burst
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func podDir(parent, uid string) string {
	return filepath.Join(parent, "kubepods-burstable-pod"+strings.ReplaceAll(uid, "-", "_")+".slice")
}

// addPod creates a pod cgroup with one container scope. Like a real cgroup
// mkdir, the directory appears with its files already in it: it is built
// beside the tree and renamed into place.
func addPod(t *testing.T, parent, uid string, oom, kill, group uint64) string {
	t.Helper()
	dir := podDir(parent, uid)
	staging := filepath.Join(filepath.Dir(filepath.Dir(parent)), ".staging-"+uid)
	scope := filepath.Join(staging, "cri-containerd-"+ctrApp+".scope")
	if err := os.MkdirAll(scope, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(scope, "cgroup.events"), "populated 1\nfrozen 0\n")
	writeEvents(t, scope, 0, 0, 0)
	mustWrite(t, filepath.Join(staging, "cgroup.events"), "populated 1\nfrozen 0\n")
	writeEvents(t, staging, oom, kill, group)
	if err := os.Rename(staging, dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeEvents(t *testing.T, dir string, oom, kill, group uint64) {
	t.Helper()
	mustWrite(t, filepath.Join(dir, "memory.events"),
		fmt.Sprintf("low 0\nhigh 0\nmax 17\noom %d\noom_kill %d\noom_group_kill %d\n", oom, kill, group))
}

func newTestWitness(root string) (*memcgWitness, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 10, 2, 13, 0, 0, 0, time.UTC)}
	w := newMemcgWitness(root)
	w.now = clk.now
	w.started = clk.now()
	return w, clk
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestPodUIDFromDir(t *testing.T) {
	cases := []struct{ name, want string }{
		{"kubepods-burstable-pod6229e6b8_ebdb_4dcf_bd72_0425d5d9afbb.slice", "6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb"},
		{"kubepods-besteffort-pod6229e6b8_ebdb_4dcf_bd72_0425d5d9afbb.slice", "6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb"},
		{"kubepods-pod6229e6b8_ebdb_4dcf_bd72_0425d5d9afbb.slice", "6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb"},
		{"pod6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb", "6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb"},
		{"cri-containerd-c7f7d422ce0bb9cc429b2fa710790239bda6a76668014de3973060184cc38445.scope", ""},
		{"kubepods-burstable.slice", ""},
		{"system.slice", ""},
	}
	for _, c := range cases {
		if got := podUIDFromDir(c.name); got != c.want {
			t.Errorf("podUIDFromDir(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestReadMemoryEvents(t *testing.T) {
	dir := t.TempDir()
	// A 5.15 kernel has no oom_group_kill line; it must read as zero.
	mustWrite(t, filepath.Join(dir, "memory.events"), "low 0\nhigh 4\nmax 1973\noom 1\noom_kill 3\n")
	c, err := readMemoryEvents(filepath.Join(dir, "memory.events"))
	if err != nil {
		t.Fatal(err)
	}
	if c != (memcgCounters{oom: 1, oomKill: 3}) {
		t.Fatalf("got %+v", c)
	}
	if _, err := readMemoryEvents(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestUnavailableWithoutCgroupV2(t *testing.T) {
	w, _ := newTestWitness(t.TempDir())
	w.rescan()
	s := w.snapshot()
	if s.Available || s.Reason == nil || !strings.Contains(*s.Reason, "cgroup v2") {
		t.Fatalf("want unavailable with a cgroup v2 reason, got %+v", s)
	}
}

func TestUnavailableWithoutKubepods(t *testing.T) {
	root := t.TempDir()
	cg := filepath.Join(root, "sys", "fs", "cgroup")
	if err := os.MkdirAll(cg, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(cg, "cgroup.controllers"), "memory\n")
	w, _ := newTestWitness(root)
	w.rescan()
	s := w.snapshot()
	if s.Available || s.Reason == nil || !strings.Contains(*s.Reason, "kubepods") {
		t.Fatalf("want unavailable naming kubepods, got %+v", s)
	}
}

func TestCgroupfsDriverLayout(t *testing.T) {
	root := t.TempDir()
	cg := filepath.Join(root, "sys", "fs", "cgroup")
	burst := filepath.Join(cg, "kubepods", "burstable")
	if err := os.MkdirAll(filepath.Join(burst, "pod"+uidA), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(cg, "cgroup.controllers"), "memory\n")
	writeEvents(t, filepath.Join(burst, "pod"+uidA), 0, 0, 0)
	w, _ := newTestWitness(root)
	w.rescan()
	if _, ok := w.snapshot().Pods[uidA]; !ok {
		t.Fatal("pod under the cgroupfs layout was not found")
	}
}

// The core contract, on rescans alone: a counter that is non-zero at start is
// a baseline of unknown time (afterMs 0); a rise later is bracketed by the two
// reads; a pod that appears later is bracketed by the previous rescan; a
// vanished pod is marked removed and eventually pruned.
func TestRescanBracketsEveryIncrease(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	dirA := addPod(t, burst, uidA, 0, 0, 0)
	addPod(t, burst, uidB, 2, 2, 1)
	w, clk := newTestWitness(root)

	w.rescan()
	t0 := clk.now()
	s := w.snapshot()
	if !s.Available {
		t.Fatalf("witness unavailable: %v", s.Reason)
	}
	if got := s.Pods[uidA]; len(got.Increases) != 0 || got.OomKill != 0 || got.LastReadMs != t0.UnixMilli() {
		t.Fatalf("pod A: %+v", got)
	}
	b := s.Pods[uidB]
	if len(b.Increases) != 1 || b.Increases[0].AfterMs != 0 || b.Increases[0].OomKill != 2 {
		t.Fatalf("pod B baseline: %+v", b)
	}

	// Pod A is OOM-killed between two rescans.
	clk.advance(30 * time.Second)
	writeEvents(t, dirA, 1, 3, 1)
	w.rescan()
	t1 := clk.now()
	a := w.snapshot().Pods[uidA]
	if len(a.Increases) != 1 {
		t.Fatalf("pod A increases: %+v", a.Increases)
	}
	inc := a.Increases[0]
	if inc.AfterMs != t0.UnixMilli() || inc.AtMs != t1.UnixMilli() || inc.Oom != 1 || inc.OomKill != 3 || inc.OomGroupKill != 1 {
		t.Fatalf("pod A increase: %+v", inc)
	}

	// Pod C appears with a kill already counted: it happened after t1.
	clk.advance(30 * time.Second)
	addPod(t, burst, uidC, 0, 1, 1)
	w.rescan()
	c := w.snapshot().Pods[uidC]
	if len(c.Increases) != 1 || c.Increases[0].AfterMs != t1.UnixMilli() {
		t.Fatalf("pod C: %+v", c)
	}

	// Pod B goes away; a zero-counter pod would be pruned after 2h, one that
	// was OOM-killed is kept for 24h.
	clk.advance(30 * time.Second)
	if err := os.RemoveAll(podDir(burst, uidB)); err != nil {
		t.Fatal(err)
	}
	w.rescan()
	removedAt := clk.now()
	if got := w.snapshot().Pods[uidB].RemovedMs; got != removedAt.UnixMilli() {
		t.Fatalf("pod B removedMs = %d, want %d", got, removedAt.UnixMilli())
	}
	clk.advance(3 * time.Hour)
	w.rescan()
	if _, ok := w.snapshot().Pods[uidB]; !ok {
		t.Fatal("an OOM-killed pod was pruned before its 24h retention")
	}
	clk.advance(22 * time.Hour)
	w.rescan()
	if _, ok := w.snapshot().Pods[uidB]; ok {
		t.Fatal("removed pod kept past its retention")
	}
}

func TestRemovedZeroPodPrunedAfterTwoHours(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	addPod(t, burst, uidA, 0, 0, 0)
	w, clk := newTestWitness(root)
	w.rescan()
	if err := os.RemoveAll(podDir(burst, uidA)); err != nil {
		t.Fatal(err)
	}
	clk.advance(time.Minute)
	w.rescan()
	clk.advance(memcgRemovedRetention + time.Minute)
	w.rescan()
	if _, ok := w.snapshot().Pods[uidA]; ok {
		t.Fatal("zero-counter removed pod kept past memcgRemovedRetention")
	}
}

// startNotifying runs the inotify half of the witness the way run() does.
func startNotifying(t *testing.T, w *memcgWitness) {
	t.Helper()
	if err := w.openInotify(); err != nil {
		t.Skipf("inotify unavailable here: %v", err)
	}
	w.rescan()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.readEvents(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		_ = w.notify.Close()
		<-done
	})
}

// The reason inotify exists: a pod that does not restart loses its cgroup
// within seconds. The kill must be read the moment memory.events changes,
// with no rescan in between.
func TestInotifyCatchesAShortLivedPodsKill(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	w, clk := newTestWitness(root)
	startNotifying(t, w)
	created := clk.now()

	clk.advance(5 * time.Second)
	dir := addPod(t, burst, uidA, 0, 0, 0)
	waitFor(t, "pod adopted from its create event", func() bool {
		_, ok := w.snapshot().Pods[uidA]
		return ok
	})

	clk.advance(2 * time.Second)
	killedAt := clk.now()
	writeEvents(t, dir, 1, 1, 1)
	waitFor(t, "increase read from the modify event", func() bool {
		return len(w.snapshot().Pods[uidA].Increases) == 1
	})
	inc := w.snapshot().Pods[uidA].Increases[0]
	if inc.AfterMs == 0 || inc.AfterMs < created.UnixMilli() || inc.AtMs != killedAt.UnixMilli() {
		t.Fatalf("increase not bracketed by the event: %+v (killed at %d)", inc, killedAt.UnixMilli())
	}

	clk.advance(time.Second)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "removal from the delete event", func() bool {
		return w.snapshot().Pods[uidA].RemovedMs != 0
	})
}

// "watched" is what lets the backend treat "no rise recorded" as proof; it
// must be true only when memory.events really is inotify-watched, and an
// overflow (lost events) must be published.
func TestWatchedFlagAndOverflows(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	addPod(t, burst, uidA, 0, 0, 0)

	rescansOnly, _ := newTestWitness(root)
	rescansOnly.rescan()
	s := rescansOnly.snapshot()
	if s.Inotify || s.Pods[uidA].Watched {
		t.Fatalf("rescan-only witness claims inotify coverage: inotify=%v watched=%v", s.Inotify, s.Pods[uidA].Watched)
	}

	w, clk := newTestWitness(root)
	startNotifying(t, w)
	s = w.snapshot()
	if !s.Inotify || !s.Pods[uidA].Watched {
		t.Fatalf("inotify witness: inotify=%v watched=%v", s.Inotify, s.Pods[uidA].Watched)
	}
	if len(s.OverflowsMs) != 0 {
		t.Fatalf("unexpected overflows: %v", s.OverflowsMs)
	}

	clk.advance(time.Minute)
	overflowAt := clk.now()
	w.mu.Lock()
	overflow := false
	w.handleEventLocked(-1, unix.IN_Q_OVERFLOW, "", overflowAt, &overflow, map[string]struct{}{})
	w.mu.Unlock()
	if !overflow {
		t.Fatal("overflow not signalled to the caller (no rescan would follow)")
	}
	if got := w.snapshot().OverflowsMs; len(got) != 1 || got[0] != overflowAt.UnixMilli() {
		t.Fatalf("overflowsMs = %v, want [%d]", got, overflowAt.UnixMilli())
	}
}

// The pod counters aggregate every container in the pod. Without per-container
// attribution, one real kill could be pinned on a sibling that died of
// something else in the same minute — so the increase names the container
// whose OWN cgroup counted it.
func TestIncreaseNamesTheKilledContainer(t *testing.T) {
	for _, mode := range []string{"inotify", "rescan"} {
		t.Run(mode, func(t *testing.T) {
			root, burst := fakeCgroupTree(t)
			dir := addPod(t, burst, uidA, 0, 0, 0)
			sidecar := filepath.Join(dir, "cri-containerd-"+ctrSidecar+".scope")
			if err := os.MkdirAll(sidecar, 0o755); err != nil {
				t.Fatal(err)
			}
			writeEvents(t, sidecar, 0, 0, 0)
			w, clk := newTestWitness(root)
			if mode == "inotify" {
				startNotifying(t, w)
			} else {
				w.rescan()
			}
			if got := len(w.pods[uidA].scopes); got != 2 {
				t.Fatalf("tracked %d container cgroups, want 2", got)
			}

			clk.advance(10 * time.Second)
			// The kernel counts the kill on the victim's cgroup and its parents.
			writeEvents(t, filepath.Join(dir, "cri-containerd-"+ctrApp+".scope"), 0, 3, 1)
			writeEvents(t, dir, 1, 3, 1)
			if mode == "rescan" {
				w.rescan()
			}
			waitFor(t, "the increase", func() bool { return len(w.snapshot().Pods[uidA].Increases) == 1 })
			inc := w.snapshot().Pods[uidA].Increases[0]
			if len(inc.ContainerIDs) != 1 || inc.ContainerIDs[0] != ctrApp {
				t.Fatalf("containerIds = %v, want only the killed container %s", inc.ContainerIDs, ctrApp)
			}
		})
	}
}

// A container cgroup that disappears is forgotten; a new one is adopted from
// its create event.
func TestContainerCgroupsComeAndGo(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	dir := addPod(t, burst, uidA, 0, 0, 0)
	w, _ := newTestWitness(root)
	startNotifying(t, w)
	appScope := filepath.Join(dir, "cri-containerd-"+ctrApp+".scope")
	if err := os.RemoveAll(appScope); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the removed container cgroup to be dropped", func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		_, ok := w.pods[uidA].scopes[ctrApp]
		return !ok
	})
	staging := filepath.Join(filepath.Dir(burst), ".staging-scope")
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	writeEvents(t, staging, 0, 0, 0)
	if err := os.Rename(staging, filepath.Join(dir, "cri-containerd-"+ctrSidecar+".scope")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the new container cgroup to be adopted", func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		_, ok := w.pods[uidA].scopes[ctrSidecar]
		return ok
	})
}

func TestContainerIDFromDir(t *testing.T) {
	id := strings.Repeat("c3", 32)
	for name, want := range map[string]string{
		"cri-containerd-" + id + ".scope": id,
		"crio-" + id + ".scope":           id,
		id:                                id,
		"cri-containerd-abc.scope":        "",
		"kubepods-burstable.slice":        "",
	} {
		if got := containerIDFromDir(name); got != want {
			t.Errorf("containerIDFromDir(%q) = %q, want %q", name, got, want)
		}
	}
}

// The backend parses this JSON; pin the field names it relies on.
func TestSnapshotWireFormat(t *testing.T) {
	root, burst := fakeCgroupTree(t)
	addPod(t, burst, uidA, 1, 1, 1)
	w, _ := newTestWitness(root)
	w.rescan()
	b, err := json.Marshal(w.snapshot())
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, key := range []string{`"version":1`, `"available":true`, `"inotify":false`, `"startedAtMs":`,
		`"rescannedAtMs":`, `"overflowsMs":[]`, `"pods":{"` + uidA + `":`, `"firstSeenMs":`, `"lastReadMs":`,
		`"watched":false`, `"oomKill":1`, `"increases":[{"afterMs":0`} {
		if !strings.Contains(s, key) {
			t.Errorf("wire JSON lacks %s: %s", key, s)
		}
	}
}

// The witness reads the host cgroup tree through a mount; without it the
// witness reports "unavailable" on every node, forever. Same class as
// TestDaemonSetMountsEveryPathTheAutoUpdateCheckReads.
func TestDaemonSetMountsTheCgroupTreeReadOnly(t *testing.T) {
	manifest := filepath.Join("..", "..", "k8s", "base", "security-probe", "daemonset.yaml")
	b, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatalf("cannot read %s: %v — if the manifest moved, update this test, do not delete it", manifest, err)
	}
	yaml := string(b)
	idx := strings.Index(yaml, "mountPath: /host/sys/fs/cgroup")
	if idx < 0 {
		t.Fatal("daemonset does not mount /host/sys/fs/cgroup — the OOM witness would be blind")
	}
	if !strings.Contains(yaml[idx:min(len(yaml), idx+120)], "readOnly: true") {
		t.Fatal("the /host/sys/fs/cgroup mount must be readOnly")
	}
	if !strings.Contains(yaml, "path: /sys/fs/cgroup\n") {
		t.Fatal("no hostPath volume for /sys/fs/cgroup")
	}
}
