package main

// memcg.go — the out-of-memory witness for pod memory cgroups.
//
// WHY THIS EXISTS
// ---------------
// The platform has to tell an admin whether a killed container ran out of
// memory. The only signal it had was the kubelet's container status, and that
// is not good enough in either direction:
//
//   - A real cgroup OOM kill can come back as {exitCode: 137, reason: "Error"}.
//     Production's VictoriaMetrics pod was OOM-killed (kernel: CONSTRAINT_MEMCG,
//     memory.events oom_kill 2) and the alert could only say "SIGKILLed, cause
//     unconfirmed".
//   - Exit 137 is 128+SIGKILL from ANY source: a probe restart, a drain, a
//     process that simply exits 137. Each of those was reported as a possible
//     OOM.
//
// The kernel keeps the answer in every pod cgroup's memory.events:
//
//   oom             the cgroup (or a descendant) hit its memory limit
//   oom_kill        processes in it were killed by the OOM killer
//   oom_group_kill  whole cgroups were killed as a group
//
// The counters are cumulative and hierarchical, and the POD cgroup outlives
// container restarts. So "oom_kill went up when this container died" proves
// an OOM, "oom went up too" proves it was the pod's own limit (a node-level
// OOM kill raises oom_kill without oom), and "no counter moved across the
// moment it died" proves it was NOT memory.
//
// cadvisor's container_oom_events_total is not a substitute: it is fed by the
// /dev/kmsg parser, and it read 0 on production through a real OOM kill.
//
// HOW
// ---
// inotify, because a pod that does not restart (a Job, restartPolicy Never)
// loses its whole cgroup within seconds of dying — a poll would miss it. The
// kernel raises a modify event on memory.events whenever a counter changes
// (cgroup_file_notify defers inside a 10 ms window, it never drops), so the
// witness reads the counters the moment a pod is OOM-killed. While a pod's
// memory.events is watched, "no rise recorded" is therefore itself evidence:
// the only blind spot is an inotify queue overflow, and those are published.
// A rescan every memcgRescanInterval re-reads everything, adopts pods whose
// creation event was missed and keeps lastRead fresh, so a lost event costs
// precision, never correctness.
//
// Read-only: it opens files under the host's /sys/fs/cgroup, nothing else.
import (
	"bufio"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// Re-read every pod's counters this often even without an inotify event.
	memcgRescanInterval = 30 * time.Second
	// How long a removed pod's record stays published. The backend reconciles
	// every five minutes; this covers a platform-api outage of the same order.
	memcgRemovedRetention = 2 * time.Hour
	// A removed pod that WAS OOM-killed is kept longer — that is the record an
	// admin may come looking for.
	memcgRemovedOOMRetention = 24 * time.Hour
	// Increases kept per pod. A crash-looping pod only needs the recent ones.
	memcgMaxIncreases = 16
	// Hard cap on published pods, so a pathological node cannot grow the
	// ConfigMap without bound. Oldest removed pods go first.
	memcgMaxPods = 2000
	// Overflow times kept — enough to cover the retention window in practice.
	memcgMaxOverflows = 8
)

// containerIDRe matches a container's own cgroup inside a pod cgroup —
// `cri-containerd-<id>.scope` (systemd driver), `crio-<id>.scope`, or a bare
// `<id>` (cgroupfs). The id is what the kubelet reports as
// lastState.terminated.containerID, so a kill can be tied to ONE container.
var containerIDRe = regexp.MustCompile(`(?:^|-)([0-9a-f]{64})(?:\.scope)?$`)

// podDirRe matches a pod cgroup directory under either cgroup driver:
//
//	systemd:  kubepods-burstable-pod0a1b2c3d_..._.slice
//	cgroupfs: pod0a1b2c3d-...
var podDirRe = regexp.MustCompile(`pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12})(?:\.slice)?$`)

// MemcgWitnessWire is published as data.memcg in the probe's ConfigMap. Read
// by backend/src/modules/node-health/oom-witness.ts — keep the two in step.
// Times are Unix milliseconds.
type MemcgWitnessWire struct {
	Version   int     `json:"version"`
	Available bool    `json:"available"`
	Reason    *string `json:"reason"`
	// Inotify is false when the witness runs on rescans alone; then only a
	// read after a container's exit proves anything about it.
	Inotify       bool  `json:"inotify"`
	StartedAtMs   int64 `json:"startedAtMs"`
	RescannedAtMs int64 `json:"rescannedAtMs"`
	// OverflowsMs: when the inotify queue overflowed (events were lost).
	OverflowsMs []int64                 `json:"overflowsMs"`
	Pods        map[string]PodMemcgWire `json:"pods"`
}

// PodMemcgWire is one pod cgroup, keyed by pod UID in MemcgWitnessWire.Pods.
type PodMemcgWire struct {
	FirstSeenMs int64 `json:"firstSeenMs"`
	LastReadMs  int64 `json:"lastReadMs"`
	RemovedMs   int64 `json:"removedMs,omitempty"`
	// Watched: memory.events has been inotify-watched since FirstSeenMs, so
	// every rise was read as it happened.
	Watched      bool                `json:"watched"`
	Oom          uint64              `json:"oom,omitempty"`
	OomKill      uint64              `json:"oomKill,omitempty"`
	OomGroupKill uint64              `json:"oomGroupKill,omitempty"`
	Increases    []MemcgIncreaseWire `json:"increases,omitempty"`
}

// MemcgIncreaseWire says the counters rose by these deltas some time in
// (AfterMs, AtMs]. AfterMs 0 means the counters were already non-zero when the
// witness first saw the pod, so WHEN they rose is unknown.
//
// ContainerIDs names the containers whose OWN cgroup counted the kill. The pod
// counters aggregate every container in the pod, so without it one real kill
// could be pinned on a sibling that died of something else at the same time.
// Empty when the container cgroup was already gone (or never adopted) by the
// time it was read; the backend then attributes conservatively.
type MemcgIncreaseWire struct {
	AfterMs      int64    `json:"afterMs"`
	AtMs         int64    `json:"atMs"`
	Oom          uint64   `json:"oom"`
	OomKill      uint64   `json:"oomKill"`
	OomGroupKill uint64   `json:"oomGroupKill"`
	ContainerIDs []string `json:"containerIds,omitempty"`
}

type memcgCounters struct {
	oom, oomKill, oomGroupKill uint64
}

func (c memcgCounters) isZero() bool { return c.oom == 0 && c.oomKill == 0 && c.oomGroupKill == 0 }

type podMemcg struct {
	dir       string
	firstSeen time.Time
	lastRead  time.Time
	removed   time.Time
	counters  memcgCounters
	increases []MemcgIncreaseWire
	wds       map[int32]struct{}
	watched   bool
	// Container cgroups inside the pod, by container id.
	scopes map[string]*scopeMemcg
	// Containers whose own counters rose before the pod's did (the kernel
	// bumps the child first); attached to the pod's next increase.
	pendingIDs map[string]struct{}
}

type scopeMemcg struct {
	dir      string
	counters memcgCounters
	wd       int32
	watched  bool
}

type memcgWitness struct {
	mu       sync.Mutex
	cgroupFS string // <hostRoot>/sys/fs/cgroup
	now      func() time.Time

	started     time.Time
	rescanned   time.Time
	initialDone bool
	unavailable string

	pods      map[string]*podMemcg // by pod UID
	overflows []time.Time

	// inotify. notify is nil when inotify could not be set up — the witness
	// then runs on rescans alone. fd is the same descriptor for the watch
	// syscalls: calling notify.Fd() would switch the file back to blocking
	// mode, and Close() could then no longer wake the reader.
	notify    *os.File
	fd        int
	wdPod     map[int32]string   // watch → pod UID
	wdScope   map[int32]scopeRef // watch → container cgroup
	wdParent  map[int32]string   // watch → QoS parent dir
	parentsOn map[string]bool
}

type scopeRef struct{ uid, id string }

func newMemcgWitness(hostRoot string) *memcgWitness {
	return &memcgWitness{
		cgroupFS:  filepath.Join(hostRoot, "sys", "fs", "cgroup"),
		now:       time.Now,
		fd:        -1,
		pods:      map[string]*podMemcg{},
		wdPod:     map[int32]string{},
		wdScope:   map[int32]scopeRef{},
		wdParent:  map[int32]string{},
		parentsOn: map[string]bool{},
	}
}

// run drives the witness until ctx ends. It never returns early: a failure
// to set up inotify degrades to rescans, and a failed rescan is retried.
func (w *memcgWitness) run(ctx context.Context) {
	w.mu.Lock()
	w.started = w.now()
	w.mu.Unlock()

	if err := w.openInotify(); err != nil {
		slog.Warn("memcg witness: inotify unavailable — rescans only", "err", err)
	}
	w.rescan()
	if w.notify != nil {
		go w.readEvents(ctx)
	}

	t := time.NewTicker(memcgRescanInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			w.mu.Lock()
			if w.notify != nil {
				_ = w.notify.Close()
			}
			w.mu.Unlock()
			return
		case <-t.C:
			w.rescan()
		}
	}
}

// kubepodsRoot finds the kubepods cgroup under either cgroup driver, or ""
// with the reason it could not.
func (w *memcgWitness) kubepodsRoot() (string, string) {
	if _, err := os.Stat(filepath.Join(w.cgroupFS, "cgroup.controllers")); err != nil {
		return "", "cgroup v2 not mounted at /sys/fs/cgroup (cgroup v1 hosts are not supported)"
	}
	for _, name := range []string{"kubepods.slice", "kubepods"} {
		p := filepath.Join(w.cgroupFS, name)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p, ""
		}
	}
	return "", "no kubepods cgroup under /sys/fs/cgroup"
}

// qosParents are the directories pod cgroups are created in: the root holds
// Guaranteed pods, the two QoS children the rest.
func qosParents(root string) []string {
	out := []string{root}
	for _, name := range []string{"kubepods-burstable.slice", "kubepods-besteffort.slice", "burstable", "besteffort"} {
		p := filepath.Join(root, name)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			out = append(out, p)
		}
	}
	return out
}

// rescan re-reads every pod cgroup, adopts new ones, marks vanished ones
// removed and prunes old records.
func (w *memcgWitness) rescan() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("memcg witness: rescan panic", "recover", r)
		}
	}()
	root, reason := w.kubepodsRoot()
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	if root == "" {
		w.unavailable = reason
		w.rescanned = now
		w.initialDone = true
		return
	}
	w.unavailable = ""

	seen := map[string]bool{}
	for _, parent := range qosParents(root) {
		w.watchParentLocked(parent)
		entries, err := os.ReadDir(parent)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			uid := podUIDFromDir(e.Name())
			if uid == "" {
				continue
			}
			seen[uid] = true
			w.adoptLocked(uid, filepath.Join(parent, e.Name()), now)
		}
	}
	for uid, p := range w.pods {
		if p.removed.IsZero() && !seen[uid] {
			p.removed = now
		}
	}
	w.pruneLocked(now)
	w.rescanned = now
	w.initialDone = true
}

// adoptLocked starts tracking a pod (when new) and reads its counters.
func (w *memcgWitness) adoptLocked(uid, dir string, now time.Time) {
	p, ok := w.pods[uid]
	if ok && p.removed.IsZero() {
		w.readPodLocked(uid, p, now)
		return
	}
	// A new pod. Before the first rescan finishes, a non-zero counter happened
	// at some unknown time before the witness started. After it, the pod did
	// not exist at the previous rescan (or its creation event would have
	// adopted it), so anything it already counted happened since then.
	var since time.Time
	if w.initialDone {
		since = w.rescanned
	}
	p = &podMemcg{
		dir: dir, firstSeen: now, wds: map[int32]struct{}{},
		scopes: map[string]*scopeMemcg{}, pendingIDs: map[string]struct{}{},
	}
	w.pods[uid] = p
	w.watchPodLocked(uid, p)
	w.syncScopesLocked(uid, p)
	c, err := readMemoryEvents(filepath.Join(dir, "memory.events"))
	if err != nil {
		// Unreadable but still there: leave it for the next read rather than
		// declaring a live pod gone.
		if !dirExists(dir) {
			p.removed = now
		}
		return
	}
	p.counters = c
	p.lastRead = now
	if !c.isZero() {
		after := int64(0)
		if !since.IsZero() {
			after = since.UnixMilli()
		}
		p.increases = append(p.increases, MemcgIncreaseWire{
			AfterMs: after, AtMs: now.UnixMilli(),
			Oom: c.oom, OomKill: c.oomKill, OomGroupKill: c.oomGroupKill,
		})
	}
}

// syncScopesLocked adopts container cgroups that appeared in the pod and
// forgets the ones that are gone. Rescans call it; between rescans, inotify
// reports new container cgroups as they are created.
func (w *memcgWitness) syncScopesLocked(uid string, p *podMemcg) {
	entries, err := os.ReadDir(p.dir)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if id := containerIDFromDir(e.Name()); id != "" {
			present[id] = true
			w.adoptScopeLocked(uid, p, e.Name())
		}
	}
	for id, s := range p.scopes {
		if !present[id] {
			w.dropScopeLocked(p, id, s)
		}
	}
}

// adoptScopeLocked starts tracking one container cgroup. Its counters at this
// point are its baseline: only a rise after it is pinned on the container.
func (w *memcgWitness) adoptScopeLocked(uid string, p *podMemcg, name string) {
	id := containerIDFromDir(name)
	if id == "" {
		return
	}
	if _, ok := p.scopes[id]; ok {
		return
	}
	s := &scopeMemcg{dir: filepath.Join(p.dir, name)}
	if c, err := readMemoryEvents(filepath.Join(s.dir, "memory.events")); err == nil {
		s.counters = c
	}
	if wd, ok := w.addWatchLocked(filepath.Join(s.dir, "memory.events"), unix.IN_MODIFY); ok {
		s.wd, s.watched = wd, true
		w.wdScope[wd] = scopeRef{uid: uid, id: id}
	}
	p.scopes[id] = s
}

func (w *memcgWitness) dropScopeLocked(p *podMemcg, id string, s *scopeMemcg) {
	if s.watched {
		delete(w.wdScope, s.wd)
		if w.fd >= 0 {
			_, _ = unix.InotifyRmWatch(w.fd, uint32(s.wd))
		}
	}
	delete(p.scopes, id)
}

// readScopesLocked re-reads every tracked container cgroup and returns the ids
// whose OWN oom_kill / oom_group_kill rose. A container cgroup that is gone is
// dropped — its last read is all there is.
func (w *memcgWitness) readScopesLocked(p *podMemcg) []string {
	var risen []string
	for id, s := range p.scopes {
		c, err := readMemoryEvents(filepath.Join(s.dir, "memory.events"))
		if err != nil {
			if !dirExists(s.dir) {
				w.dropScopeLocked(p, id, s)
			}
			continue
		}
		if c.oomKill > s.counters.oomKill || c.oomGroupKill > s.counters.oomGroupKill {
			risen = append(risen, id)
		}
		s.counters = c
	}
	return risen
}

// readPodLocked re-reads a live pod's counters and records any rise, naming
// the containers whose own cgroups counted it.
func (w *memcgWitness) readPodLocked(uid string, p *podMemcg, now time.Time) {
	// Containers first: the kernel counts a kill on the victim's cgroup before
	// its parents, so reading in the same order never sees the pod rise
	// without the container that caused it. Re-list them too, so a container
	// whose create event was missed is still compared.
	w.syncScopesLocked(uid, p)
	for _, id := range w.readScopesLocked(p) {
		p.pendingIDs[id] = struct{}{}
	}
	c, err := readMemoryEvents(filepath.Join(p.dir, "memory.events"))
	if err != nil {
		if p.removed.IsZero() && !dirExists(p.dir) {
			p.removed = now
		}
		return
	}
	if p.lastRead.IsZero() {
		// First successful read of a pod adopted before its files existed:
		// treat it like adoption after the previous rescan.
		p.counters = c
		p.lastRead = now
		if !c.isZero() {
			p.increases = append(p.increases, MemcgIncreaseWire{
				AfterMs: p.firstSeen.UnixMilli(), AtMs: now.UnixMilli(),
				Oom: c.oom, OomKill: c.oomKill, OomGroupKill: c.oomGroupKill,
			})
		}
		return
	}
	prev := p.counters
	if c.oom > prev.oom || c.oomKill > prev.oomKill || c.oomGroupKill > prev.oomGroupKill {
		var ids []string
		for id := range p.pendingIDs {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		p.pendingIDs = map[string]struct{}{}
		p.increases = append(p.increases, MemcgIncreaseWire{
			AfterMs:      p.lastRead.UnixMilli(),
			AtMs:         now.UnixMilli(),
			Oom:          sub(c.oom, prev.oom),
			OomKill:      sub(c.oomKill, prev.oomKill),
			OomGroupKill: sub(c.oomGroupKill, prev.oomGroupKill),
			ContainerIDs: ids,
		})
		if len(p.increases) > memcgMaxIncreases {
			p.increases = append([]MemcgIncreaseWire(nil), p.increases[len(p.increases)-memcgMaxIncreases:]...)
		}
		slog.Info("memcg witness: OOM counters rose", "podUid", uid,
			"oom", c.oom, "oomKill", c.oomKill, "oomGroupKill", c.oomGroupKill, "containers", ids)
	}
	p.counters = c
	p.lastRead = now
}

func dirExists(dir string) bool {
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

func sub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func (w *memcgWitness) pruneLocked(now time.Time) {
	for uid, p := range w.pods {
		if p.removed.IsZero() {
			continue
		}
		keep := memcgRemovedRetention
		if !p.counters.isZero() {
			keep = memcgRemovedOOMRetention
		}
		if now.Sub(p.removed) > keep {
			w.forgetLocked(uid, p)
		}
	}
	if len(w.pods) <= memcgMaxPods {
		return
	}
	removed := make([]string, 0, len(w.pods))
	for uid, p := range w.pods {
		if !p.removed.IsZero() {
			removed = append(removed, uid)
		}
	}
	sort.Slice(removed, func(i, j int) bool { return w.pods[removed[i]].removed.Before(w.pods[removed[j]].removed) })
	for _, uid := range removed {
		if len(w.pods) <= memcgMaxPods {
			break
		}
		w.forgetLocked(uid, w.pods[uid])
	}
}

func (w *memcgWitness) forgetLocked(uid string, p *podMemcg) {
	for id, sc := range p.scopes {
		w.dropScopeLocked(p, id, sc)
	}
	for wd := range p.wds {
		delete(w.wdPod, wd)
		if w.fd >= 0 {
			_, _ = unix.InotifyRmWatch(w.fd, uint32(wd))
		}
	}
	delete(w.pods, uid)
}

// ── snapshot + parsing ──────────────────────────────────────────────────────

func (w *memcgWitness) snapshot() MemcgWitnessWire {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := MemcgWitnessWire{
		Version:       1,
		Available:     w.unavailable == "" && w.initialDone,
		Inotify:       w.notify != nil,
		StartedAtMs:   w.started.UnixMilli(),
		RescannedAtMs: unixMilliOrZero(w.rescanned),
		OverflowsMs:   make([]int64, 0, len(w.overflows)),
		Pods:          make(map[string]PodMemcgWire, len(w.pods)),
	}
	for _, o := range w.overflows {
		out.OverflowsMs = append(out.OverflowsMs, o.UnixMilli())
	}
	if w.unavailable != "" {
		r := w.unavailable
		out.Reason = &r
	} else if !w.initialDone {
		r := "first scan not finished"
		out.Reason = &r
	}
	for uid, p := range w.pods {
		pw := PodMemcgWire{
			FirstSeenMs:  p.firstSeen.UnixMilli(),
			LastReadMs:   unixMilliOrZero(p.lastRead),
			Watched:      p.watched,
			Oom:          p.counters.oom,
			OomKill:      p.counters.oomKill,
			OomGroupKill: p.counters.oomGroupKill,
		}
		if !p.removed.IsZero() {
			pw.RemovedMs = p.removed.UnixMilli()
		}
		if len(p.increases) > 0 {
			pw.Increases = append([]MemcgIncreaseWire(nil), p.increases...)
		}
		out.Pods[uid] = pw
	}
	return out
}

func unixMilliOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// containerIDFromDir returns the container id a container cgroup directory
// name encodes, or "" when it is not one.
func containerIDFromDir(name string) string {
	m := containerIDRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	return m[1]
}

// podUIDFromDir returns the dashed pod UID a cgroup directory name encodes,
// or "" when it is not a pod cgroup.
func podUIDFromDir(name string) string {
	m := podDirRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	return strings.ReplaceAll(m[1], "_", "-")
}

// readMemoryEvents parses a cgroup v2 memory.events file. Missing keys read
// as zero (oom_group_kill only exists on kernels >= 5.17).
func readMemoryEvents(path string) (memcgCounters, error) {
	f, err := os.Open(path)
	if err != nil {
		return memcgCounters{}, err
	}
	defer f.Close()
	var c memcgCounters
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "oom":
			c.oom = v
		case "oom_kill":
			c.oomKill = v
		case "oom_group_kill":
			c.oomGroupKill = v
		}
	}
	return c, sc.Err()
}
