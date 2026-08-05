package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// Host-migration status relay.
//
// platform-ops (the host-side converger) owns the migration state: it has the
// catalog, it runs the scripts, it writes the markers. But it cannot publish
// that state from a worker node -- its kubeconfig is `get` on five ConfigMaps,
// and RBAC cannot scope `create` by resourceName, so granting a worker the
// ability to create its own status ConfigMap would let it create ANY ConfigMap
// in platform-system.
//
// This reconciler already runs on every node and already publishes one
// per-node ConfigMap under an OwnerReference. So the converge writes a
// node-local status.json and we relay it verbatim. Read-only mount, no new
// RBAC, no host mutation -- the observe-mode posture is unchanged.
const defaultMigrationStatusPath = "/host/var/lib/platform/host-migrations/status.json"

// Caps on what we relay. A failed migration's stderr is captured verbatim, and
// a pathological script can emit a lot of it — the whole Snapshot goes into ONE
// ConfigMap key, and etcd rejects a ConfigMap over ~1 MiB. Uncapped, a noisy
// failure would not merely bloat the document: publish() would fail and freeze
// this node's reporting at its last-known state, which is exactly the moment
// the panel matters most. So cap here rather than trusting the writer.
const (
	maxStatusFileBytes = 1 << 20 // refuse to parse beyond this
	maxMigrationItems  = 300
	maxMigrationField  = 512
)

// clip truncates on a rune boundary — a byte-sliced string would be invalid
// UTF-8 and json.Marshal would silently replace the tail with U+FFFD.
func clip(s string) string {
	if len(s) <= maxMigrationField {
		return s
	}
	s = s[:maxMigrationField]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "… (truncated)"
}

// clipPtr is the optional-field form: nil stays nil, so an absent error keeps
// its "absent" meaning rather than becoming an empty string.
func clipPtr(s *string) *string {
	if s == nil {
		return nil
	}
	c := clip(*s)
	return &c
}

func isApplied(state string) bool {
	return state == "applied" || state == "already-applied"
}

// capItems bounds the item list while PRESERVING ORDER and, crucially, keeping
// every failed/blocked/pending item: those are the whole point of the relay.
// Applied migrations are dropped first — they are already summarised by
// appliedCount, and the panel filters them out of the list anyway.
func capItems(items []MigrationItem) ([]MigrationItem, bool) {
	if len(items) <= maxMigrationItems {
		return items, false
	}
	keep := make([]bool, len(items))
	n := 0
	for i, it := range items {
		if !isApplied(it.State) {
			keep[i] = true
			n++
		}
	}
	for i := range items { // backfill applied ones only if there is room left
		if n >= maxMigrationItems {
			break
		}
		if !keep[i] {
			keep[i] = true
			n++
		}
	}
	out := make([]MigrationItem, 0, n)
	for i, k := range keep {
		if k {
			out = append(out, items[i])
		}
	}
	if len(out) > maxMigrationItems { // >300 genuine failures: nothing left to drop
		out = out[:maxMigrationItems]
	}
	return out, true
}

// readMigrationStatus returns the relayed document, or nil when the node has no
// status yet. A node that has never converged is NORMAL (fresh install, or the
// policy is observe) -- it must not read as an error.
func readMigrationStatus(path string) (*MigrationStatus, []string) {
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // never converged yet — not an error
		}
		return nil, []string{"host-migration status unreadable: " + err.Error()}
	}
	defer f.Close() //nolint:errcheck // read-only
	// Read one byte past the ceiling so an oversized file is detectable rather
	// than silently parsed from a truncated prefix.
	raw, err := io.ReadAll(io.LimitReader(f, maxStatusFileBytes+1))
	if err != nil {
		return nil, []string{"host-migration status unreadable: " + err.Error()}
	}
	if len(raw) > maxStatusFileBytes {
		return nil, []string{"host-migration status too large to relay"}
	}
	var st MigrationStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, []string{"host-migration status malformed: " + err.Error()}
	}
	// Derive the counts the UI needs BEFORE capping, so a truncated list can
	// never under-report a failure. The backend takes max(relayed, recounted)
	// for exactly this reason.
	for _, it := range st.Items {
		switch it.State {
		case "run-failed":
			st.FailedCount++
		case "blocked":
			st.BlockedCount++
		case "would-run":
			st.PendingCount++
		case "skipped":
			st.SkippedCount++
		}
	}

	// Now bound what actually travels. Counts above are already final.
	for i := range st.Items {
		st.Items[i].Error = clipPtr(st.Items[i].Error)
		st.Items[i].SkipReason = clipPtr(st.Items[i].SkipReason)
		st.Items[i].Key = clip(st.Items[i].Key)
	}
	items, truncated := capItems(st.Items)
	st.Items = items
	if truncated {
		return &st, []string{"host-migration list truncated for relay (counts are still exact)"}
	}
	return &st, nil
}
