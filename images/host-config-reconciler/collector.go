package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// collector reads the live host sysctls from a READ-ONLY /proc/sys mount and
// diffs them against the desired policy. It never writes host state.
type collector struct {
	hostRoot string // mount root for host paths, e.g. "/host"
	nodeName string
	now      func() time.Time
	allow    func(string) bool
}

func newCollector(hostRoot, nodeName string) *collector {
	return &collector{hostRoot: hostRoot, nodeName: nodeName, now: time.Now, allow: sysctlAllowed}
}

// normalizeSysctl collapses internal whitespace runs to single spaces and
// trims — matching how `sysctl` renders multi-field values (e.g. the three
// numbers of net.ipv4.tcp_rmem) so equal values compare equal.
func normalizeSysctl(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// readActualSysctl reads a sysctl's live value from the read-only /proc/sys
// mount. Path-contained: even after the key guards in sysctlKeyToPath, the
// cleaned absolute path must stay under <hostRoot>/proc/sys.
func (c *collector) readActualSysctl(key string) (string, bool) {
	rel, ok := sysctlKeyToPath(key)
	if !ok {
		return "", false
	}
	base := filepath.Join(c.hostRoot, "proc", "sys")
	full := filepath.Join(base, rel)
	if full != base && !strings.HasPrefix(full, base+string(os.PathSeparator)) {
		return "", false
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	return normalizeSysctl(string(b)), true
}

// collect builds a Snapshot by comparing each desired sysctl against the live
// host value. A nil desired (ConfigMap absent) yields an empty observe report.
func (c *collector) collect(desired *DesiredConfig) Snapshot {
	snap := Snapshot{
		Node:        c.nodeName,
		CollectedAt: c.now().UTC().Format(time.RFC3339),
		Mode:        "observe",
	}
	if desired == nil {
		snap.DesiredSource = "absent"
		return snap
	}
	snap.DesiredSource = "configmap"
	for _, d := range desired.Sysctls {
		item := SysctlItem{Key: d.Key, Desired: d.Value}
		switch {
		case !c.allow(d.Key):
			item.State = "not-allowed"
		default:
			actual, ok := c.readActualSysctl(d.Key)
			if !ok {
				item.State = "unreadable"
				break
			}
			item.Actual = actual
			if normalizeSysctl(d.Value) == actual {
				item.State = "ok"
			} else {
				item.State = "drift"
				snap.DriftCount++
			}
		}
		snap.Sysctls = append(snap.Sysctls, item)
	}
	return snap
}
