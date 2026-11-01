// Boot-restore file for the peer/trusted sets.

package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// peerPersister writes the peer/trusted members as an nft script that
// /etc/nftables.conf includes at boot.
//
// Why this exists: nftables restores the set DECLARATIONS at boot, but members
// are runtime state and a reboot discards them. `cluster_peers_v{4,6}` gates
// inbound etcd/apiserver/kubelet traffic under a `policy drop` chain, so an
// empty set after a reboot means no peer can reach the node — etcd reports
// "failed to publish local member to cluster through raft" and the node never
// rejoins.
//
// That deadlocks, because the only thing that fills the set is this
// reconciler, which runs as a DaemonSet INSIDE the cluster the node can no
// longer join. Measured on staging: a rebooted server sat NotReady for 19
// minutes, untouched by the hourly host-config converger (which does not
// manage these sets), and rejoined 21 seconds after the members were restored
// by hand.
//
// The restored list can be briefly stale — a departed peer stays allowed until
// the first reconcile overwrites this file — which is a far better failure mode
// than a control-plane node that cannot come back at all.
//
// The file has to survive a power cut, not only a clean reboot. A replace that
// is not synced can come back as a zero-length file: the rename can reach the
// disk before the data does, and XFS (the RHEL family's default) then shows the
// new name with no content. A lab server cut off within a second of a
// rewrite booted with an empty file, empty peer sets and the same deadlock,
// for 55 minutes. So a replace syncs the data before the rename and the
// directory after it, and an unchanged file is never replaced at all — the
// reconciler applies every 30 s, and each needless rewrite reopened the window.
type peerPersister struct {
	path string
	// synced is the content this process has seen reach stable storage. nil
	// until the first persist, so a new process syncs once even when the file
	// already matches: the writer before it may not have synced.
	synced []byte
	// fsync is (*os.File).Sync; tests replace it to observe the ordering.
	fsync func(*os.File) error
}

func newPeerPersister(path string) *peerPersister {
	return &peerPersister{path: path, fsync: (*os.File).Sync}
}

// persist brings the file in line with s. On error the file holds either the
// previous content or the new content, never a mix, and the next call retries.
func (p *peerPersister) persist(s peerNftSets) error {
	want := renderPeerSets(s)
	if have, err := os.ReadFile(p.path); err == nil && bytes.Equal(have, want) {
		if bytes.Equal(p.synced, want) {
			return nil
		}
		if err := p.syncExisting(); err != nil {
			return err
		}
		p.synced = want
		return nil
	}
	// Missing, different or unreadable: replace it. Renaming a new file over
	// an unreadable one is also how a damaged file gets repaired.
	if err := p.replace(want); err != nil {
		return err
	}
	p.synced = want
	return nil
}

// replace writes content next to the target, syncs it, renames it over the
// target and syncs the directory so the rename itself is durable. A
// half-written include file would make nftables fail to load at boot, which is
// strictly worse than having no file at all — hence never writing in place.
func (p *peerPersister) replace(content []byte) error {
	dir := filepath.Dir(p.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	// The suffix keeps a leftover from a crash out of the `*.conf` include.
	tmp := p.path + ".tmp"
	if err := p.writeSynced(tmp, content); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s: %w", tmp, err)
	}
	return p.syncPath(dir)
}

func (p *peerPersister) writeSynced(path string, content []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := p.fsync(f); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}

// syncExisting makes a file that already holds the right content durable,
// without replacing it.
func (p *peerPersister) syncExisting() error {
	if err := p.syncPath(p.path); err != nil {
		return err
	}
	return p.syncPath(filepath.Dir(p.path))
}

func (p *peerPersister) syncPath(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s for sync: %w", path, err)
	}
	defer f.Close() //nolint:errcheck // read-only handle; the sync result is what matters
	if err := p.fsync(f); err != nil {
		return fmt.Errorf("sync %s: %w", path, err)
	}
	return nil
}

// renderPeerSets produces the nft script for s. The output is a function of
// the member sets only, not of their order, so an unchanged set compares equal
// to the file on disk.
func renderPeerSets(s peerNftSets) []byte {
	var b strings.Builder
	b.WriteString("# Generated by firewall-reconciler. Do not edit.\n")
	b.WriteString("# Last-known-good set members, replayed at boot so a rebooted node\n")
	b.WriteString("# can reach its peers before the cluster is reachable.\n")
	writeSet := func(name string, members []string) {
		if len(members) == 0 {
			return
		}
		sorted := append([]string(nil), members...)
		sort.Strings(sorted)
		fmt.Fprintf(&b, "add element inet filter %s { %s }\n", name, strings.Join(sorted, ", "))
	}
	writeSet(setPeersV4, s.PeersV4)
	writeSet(setPeersV6, s.PeersV6)
	writeSet(setTrustedV4, s.TrustedV4)
	writeSet(setTrustedV6, s.TrustedV6)
	return []byte(b.String())
}
