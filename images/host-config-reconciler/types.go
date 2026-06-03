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

// AppliedSnapshot is the JSON document the CONVERGE-role pod writes to
// host-config-applied-<node>.data.applied (W10 enforce mode). It records what
// the privileged enforcer did (or, in dry-run, WOULD do) to converge the node
// to the desired sysctls. The observe-only detector never produces this.
type AppliedSnapshot struct {
	Node        string `json:"node"`
	CollectedAt string `json:"collectedAt"`
	// "configmap" when host-config-desired was found, "absent" otherwise.
	DesiredSource string `json:"desiredSource"`
	// "enforce" (writes applied) | "dry-run" (reports would-apply, no writes).
	Mode         string        `json:"mode"`
	Items        []AppliedItem `json:"items"`
	AppliedCount int           `json:"appliedCount"`
	Errors       []string      `json:"errors,omitempty"`
}

// AppliedItem is one desired sysctl's convergence outcome.
type AppliedItem struct {
	Key     string `json:"key"`
	Desired string `json:"desired"`
	// Live value AFTER the loop (post-write when applied); empty when unreadable.
	Actual string `json:"actual"`
	// "applied" | "would-apply" | "ok" | "unreadable" | "not-allowed" | "write-failed".
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}
