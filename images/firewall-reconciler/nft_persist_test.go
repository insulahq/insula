package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The bug this guards, measured on staging:
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
//
// The file then has to survive a power cut too. A lab server cut off within a
// second of an unsynced rewrite booted with a zero-length file and the same
// deadlock, for 55 minutes.

func readPersisted(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted file: %v", err)
	}
	return string(b)
}

func mustPersist(t *testing.T, p *peerPersister, s peerNftSets) {
	t.Helper()
	if err := p.persist(s); err != nil {
		t.Fatalf("persist: %v", err)
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return fi
}

// syncRecorder stands in for (*os.File).Sync and records each call with what
// the target held at that moment, so a test can check the ordering.
type syncRecorder struct {
	target string
	calls  []syncCall
	fail   func(name string) error
}

type syncCall struct {
	name         string
	fileAtCall   string // what the synced file held; "" for a directory
	targetAtCall string // "" when the target did not exist yet
}

func (r *syncRecorder) sync(f *os.File) error {
	held, _ := os.ReadFile(r.target)
	synced, _ := os.ReadFile(f.Name())
	r.calls = append(r.calls, syncCall{name: f.Name(), fileAtCall: string(synced), targetAtCall: string(held)})
	if r.fail != nil {
		return r.fail(f.Name())
	}
	return f.Sync()
}

func recordedPersister(path string) (*peerPersister, *syncRecorder) {
	rec := &syncRecorder{target: path}
	p := newPeerPersister(path)
	p.fsync = rec.sync
	return p, rec
}

var (
	setsA = peerNftSets{PeersV4: []string{"10.0.0.1", "10.0.0.2"}}
	setsB = peerNftSets{PeersV4: []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}}
)

func TestPersistPeerSetsWritesReplayableElements(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "10-cluster-peers.conf")
	mustPersist(t, newPeerPersister(path), peerNftSets{
		PeersV4:   []string{"10.0.0.2", "10.0.0.1"},
		PeersV6:   []string{"2001:db8::1"},
		TrustedV4: []string{"192.0.2.0/24"},
		TrustedV6: []string{"2001:db8:1::/48"},
	})

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

func TestRenderPeerSetsIsDeterministic(t *testing.T) {
	// Same members in a different order must produce identical bytes, or the
	// unchanged-file check never matches and every reconcile replaces the file.
	a := renderPeerSets(peerNftSets{PeersV4: []string{"10.0.0.3", "10.0.0.1", "10.0.0.2"}})
	b := renderPeerSets(peerNftSets{PeersV4: []string{"10.0.0.2", "10.0.0.3", "10.0.0.1"}})
	if string(a) != string(b) {
		t.Errorf("output depends on input order:\nA:\n%s\nB:\n%s", a, b)
	}
}

func TestPersistPeerSetsOmitsEmptySets(t *testing.T) {
	// `add element … { }` is a syntax error, which would make nftables fail to
	// load at boot — strictly worse than the bug being fixed.
	got := string(renderPeerSets(peerNftSets{PeersV4: []string{"10.0.0.1"}}))
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
	mustPersist(t, newPeerPersister(path), peerNftSets{})
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
	p := newPeerPersister(path)
	mustPersist(t, p, peerNftSets{PeersV4: []string{"10.0.0.1", "10.0.0.9"}})
	mustPersist(t, p, peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if got := readPersisted(t, path); strings.Contains(got, "10.0.0.9") {
		t.Errorf("removed peer still present after rewrite:\n%s", got)
	}
}

func TestPersistPeerSetsLeavesNoTempFile(t *testing.T) {
	// Written via write-then-rename; a stray .tmp is outside the *.conf
	// include, but a leak is still a bug.
	dir := t.TempDir()
	p := newPeerPersister(filepath.Join(dir, "peers.conf"))
	mustPersist(t, p, setsA)
	mustPersist(t, p, setsB)
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

func TestPersistSyncsTheDataBeforeTheRenameAndTheDirectoryAfter(t *testing.T) {
	// The zero-length file after a power cut: without the first sync the
	// rename can reach the disk before the data; without the second the
	// rename itself can be lost.
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	p, rec := recordedPersister(path)
	mustPersist(t, p, setsA)
	rec.calls = nil

	mustPersist(t, p, setsB)

	want := []syncCall{
		{name: path + ".tmp", fileAtCall: string(renderPeerSets(setsB)), targetAtCall: string(renderPeerSets(setsA))},
		{name: dir, targetAtCall: string(renderPeerSets(setsB))},
	}
	if len(rec.calls) != len(want) {
		t.Fatalf("sync calls = %+v, want %+v", rec.calls, want)
	}
	for i := range want {
		if rec.calls[i] != want[i] {
			t.Errorf("sync call %d = %+v, want %+v", i, rec.calls[i], want[i])
		}
	}
}

func TestPersistLeavesAnUnchangedFileAlone(t *testing.T) {
	// The reconciler applies every 30 s. Replacing an unchanged file each time
	// reopened the window in which a power cut leaves it empty.
	path := filepath.Join(t.TempDir(), "peers.conf")
	p, rec := recordedPersister(path)
	mustPersist(t, p, setsA)
	before := mustStat(t, path)
	rec.calls = nil

	reordered := peerNftSets{PeersV4: []string{setsA.PeersV4[1], setsA.PeersV4[0]}}
	mustPersist(t, p, reordered)

	if !os.SameFile(before, mustStat(t, path)) {
		t.Error("an unchanged file was replaced")
	}
	if len(rec.calls) != 0 {
		t.Errorf("an unchanged, already synced file was synced again: %+v", rec.calls)
	}
}

func TestPersistSyncsAMatchingFileFromAnEarlierWriterOnce(t *testing.T) {
	// After an upgrade the file holds what the old pod wrote, possibly unsynced
	// and only seconds old. The bytes match, so it is not replaced, but the new
	// process cannot know it reached the disk, so it syncs it once.
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	if err := os.WriteFile(path, renderPeerSets(setsA), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before := mustStat(t, path)
	p, rec := recordedPersister(path)

	mustPersist(t, p, setsA)

	if !os.SameFile(before, mustStat(t, path)) {
		t.Error("a matching file was replaced instead of synced")
	}
	if len(rec.calls) != 2 || rec.calls[0].name != path || rec.calls[1].name != dir {
		t.Errorf("sync calls = %+v, want the file then %s", rec.calls, dir)
	}
	rec.calls = nil
	mustPersist(t, p, setsA)
	if len(rec.calls) != 0 {
		t.Errorf("synced again on the next tick: %+v", rec.calls)
	}
}

func TestPersistRestoresAFileEmptiedBehindItsBack(t *testing.T) {
	// The in-process record is not trusted over the disk: an emptied file is
	// rewritten on the next tick.
	path := filepath.Join(t.TempDir(), "peers.conf")
	p := newPeerPersister(path)
	mustPersist(t, p, setsA)
	if err := os.Truncate(path, 0); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	mustPersist(t, p, setsA)

	if got := readPersisted(t, path); got != string(renderPeerSets(setsA)) {
		t.Errorf("file not restored, got:\n%s", got)
	}
}

func TestPersistKeepsThePreviousFileWhenTheDataSyncFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	p, rec := recordedPersister(path)
	mustPersist(t, p, setsA)
	rec.fail = func(name string) error {
		if name == path+".tmp" {
			return errors.New("injected EIO")
		}
		return nil
	}

	err := p.persist(setsB)

	if err == nil || !strings.Contains(err.Error(), "sync") {
		t.Fatalf("err = %v, want a sync error", err)
	}
	if got := readPersisted(t, path); got != string(renderPeerSets(setsA)) {
		t.Errorf("target changed although its replacement was never synced:\n%s", got)
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("temp file left behind after the failure: %v", err)
	}
	rec.fail = nil
	mustPersist(t, p, setsB)
	if got := readPersisted(t, path); got != string(renderPeerSets(setsB)) {
		t.Errorf("not retried on the next tick, got:\n%s", got)
	}
}

func TestPersistRetriesADirectorySyncThatFailed(t *testing.T) {
	// The rename happened but may not be durable; the next tick must sync
	// again rather than treat the matching bytes as done.
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	p, rec := recordedPersister(path)
	rec.fail = func(name string) error {
		if name == dir {
			return errors.New("injected EIO")
		}
		return nil
	}
	if err := p.persist(setsA); err == nil {
		t.Fatal("expected the directory sync error to be returned")
	}
	rec.fail = nil
	rec.calls = nil
	before := mustStat(t, path)

	mustPersist(t, p, setsA)

	if !os.SameFile(before, mustStat(t, path)) {
		t.Error("replaced the file instead of syncing it")
	}
	if len(rec.calls) != 2 || rec.calls[1].name != dir {
		t.Errorf("sync calls = %+v, want the file then %s", rec.calls, dir)
	}
}

func TestPersistRetriesAFailedSyncOfAMatchingFile(t *testing.T) {
	// A file from an earlier writer whose sync fails is not recorded as done.
	path := filepath.Join(t.TempDir(), "peers.conf")
	if err := os.WriteFile(path, renderPeerSets(setsA), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	p, rec := recordedPersister(path)
	rec.fail = func(name string) error {
		if name == path {
			return errors.New("injected EIO")
		}
		return nil
	}
	if err := p.persist(setsA); err == nil {
		t.Fatal("expected the file sync error to be returned")
	}
	rec.fail = nil
	rec.calls = nil

	mustPersist(t, p, setsA)

	if len(rec.calls) != 2 || rec.calls[0].name != path {
		t.Errorf("sync calls = %+v, want the file synced again", rec.calls)
	}
}

func TestPersistLeavesNoTempFileWhenTheRenameFails(t *testing.T) {
	// A directory in the target's place: the read fails, the replace is tried
	// and its rename is refused.
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.conf")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}

	err := newPeerPersister(path).persist(setsA)

	if err == nil || !strings.Contains(err.Error(), "rename") {
		t.Fatalf("err = %v, want a rename error", err)
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("temp file left behind after the failure: %v", err)
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

func TestTheRealApplierPersistsToThePeerPersistPath(t *testing.T) {
	if got := newRealApplier().peers.path; got != peerPersistPath {
		t.Errorf("realApplier persists to %q, want %q", got, peerPersistPath)
	}
}

// The persist path is useless unless the DaemonSet actually mounts the host
// directory it writes to. rc.7 shipped persistPeerSets with no mount at all:
// the container has readOnlyRootFilesystem, so every tick logged
//
//	could not persist peer sets for boot restore
//	err="mkdir /etc/nftables.d: read-only file system"
//
// and the fix silently did nothing on every node. The code was deployed; the
// behaviour was absent. Guard the contract the manifest has to satisfy.
func TestPeerPersistPathMatchesTheMountedHostDirectory(t *testing.T) {
	// k8s/base/firewall-reconciler/daemonset.yaml mounts a hostPath at
	// exactly this path. If this constant moves, that mount must move with it.
	const mountedDir = "/etc/nftables.d"
	if got := filepath.Dir(peerPersistPath); got != mountedDir {
		t.Fatalf("peerPersistPath dir = %q, but the DaemonSet mounts %q — "+
			"the write would land in the read-only container rootfs", got, mountedDir)
	}
}

func TestPersistPeerSetsSurfacesAnUnwritableTarget(t *testing.T) {
	// The caller logs a warning rather than failing the apply, so the error
	// must be returned and descriptive — that warning is the only signal an
	// operator gets that boot-restore is not working.
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("seed blocker: %v", err)
	}
	err := newPeerPersister(filepath.Join(blocker, "peers.conf")).persist(setsA)
	if err == nil {
		t.Fatal("expected an error when the parent path is not a directory")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Errorf("error should name the offending path, got %v", err)
	}
}
