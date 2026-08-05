package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// readMigrationStatus returns the relayed document, or nil when the node has no
// status yet. A node that has never converged is NORMAL (fresh install, or the
// policy is observe) -- it must not read as an error.
func readMigrationStatus(path string) (*MigrationStatus, []string) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // never converged yet — not an error
		}
		return nil, []string{"host-migration status unreadable: " + err.Error()}
	}
	var st MigrationStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, []string{"host-migration status malformed: " + err.Error()}
	}
	// Derive the counts the UI needs, so every consumer agrees on them rather
	// than each re-deriving from `items` and drifting.
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
	return &st, nil
}
