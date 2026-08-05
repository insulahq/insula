package main

// Snapshot is the JSON document the reconciler writes to
// host-config-drift-<node>.data.snapshot. It is the read-only contract with
// the backend (drift surfacing + nightly alert). OBSERVE MODE: the reconciler
// never writes host state — it reports desired-vs-actual only.
type Snapshot struct {
	Node        string       `json:"node"`
	CollectedAt string       `json:"collectedAt"`
	// "configmap" when host-config-desired was found, "absent" otherwise.
	DesiredSource string `json:"desiredSource"`
	// Always "observe" in this release — write/enforce mode is a later PR.
	Mode       string       `json:"mode"`
	Sysctls    []SysctlItem `json:"sysctls"`
	DriftCount int          `json:"driftCount"`
	Errors     []string     `json:"errors,omitempty"`
	// Relayed host-migration state (nil when the node has never converged).
	HostMigrations *MigrationStatus `json:"hostMigrations,omitempty"`
}

// SysctlItem is one desired sysctl compared against the live host value.
type SysctlItem struct {
	Key     string `json:"key"`
	Desired string `json:"desired"`
	// Live value from /proc/sys; empty when unreadable / not-allowed.
	Actual string `json:"actual"`
	// "ok" | "drift" | "unreadable" | "not-allowed".
	State string `json:"state"`
}

// MigrationStatus is the host-migration document relayed verbatim from the
// node-local status.json that platform-ops writes after every converge. The
// reconciler does not interpret migrations — it only carries them to the API so
// the admin panel can show a failed or blocked chain instead of it being
// invisible until someone SSHes in.
type MigrationStatus struct {
	Schema       int             `json:"schema"`
	CollectedAt  string          `json:"collectedAt"`
	Mode         string          `json:"mode"`
	Source       string          `json:"source"`
	OK           bool            `json:"ok"`
	AppliedCount int             `json:"appliedCount"`
	Reason       *string         `json:"reason,omitempty"`
	Items        []MigrationItem `json:"items"`

	// Derived by the relay so every consumer agrees on them.
	FailedCount  int `json:"failedCount"`
	BlockedCount int `json:"blockedCount"`
	PendingCount int `json:"pendingCount"`
	SkippedCount int `json:"skippedCount"`
}

// MigrationItem mirrors the runner's per-script result (ADR-045 W10c, ADR-056).
type MigrationItem struct {
	Key   string  `json:"key"`
	State string  `json:"state"`
	Error *string `json:"error,omitempty"`
	// ADR-056: how long this has been failing, so a five-week wedge is legible.
	Attempt      *int    `json:"attempt,omitempty"`
	FailingSince *string `json:"failingSince,omitempty"`
	SkipReason   *string `json:"skipReason,omitempty"`
}
