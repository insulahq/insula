package main

import (
	"fmt"
	"os"
	"time"
)

// sysctlIO abstracts reading + writing host sysctls so the converge logic is
// unit-testable without touching /proc/sys. realSysctlIO is the ONLY thing that
// mutates host state.
type sysctlIO interface {
	read(key string) (string, bool)
	write(key, value string) error
}

// converge brings allow-listed, drifting sysctls to their desired values.
//
// SAFETY: a non-allow-listed key is classified "not-allowed" and is NEVER read
// or written — the write path is gated HERE and re-checked in realSysctlIO.write
// (defence in depth). When enforcing is false this is a DRY-RUN: drifting keys
// are reported "would-apply" and nothing is written. Pure over sysctlIO so the
// whole decision tree (incl. the never-write-not-allowed invariant) is testable.
func converge(desired *DesiredConfig, enforcing bool, io sysctlIO, allow func(string) bool, now func() time.Time, node string) AppliedSnapshot {
	snap := AppliedSnapshot{
		Node:        node,
		CollectedAt: now().UTC().Format(time.RFC3339),
		Mode:        "dry-run",
	}
	if enforcing {
		snap.Mode = "enforce"
	}
	if desired == nil {
		snap.DesiredSource = "absent"
		return snap
	}
	snap.DesiredSource = "configmap"
	for _, d := range desired.Sysctls {
		want := normalizeSysctl(d.Value)
		item := AppliedItem{Key: d.Key, Desired: want}
		switch {
		case !allow(d.Key):
			item.State = "not-allowed" // never read, never written
		default:
			actual, ok := io.read(d.Key)
			if !ok {
				item.State = "unreadable"
				break
			}
			item.Actual = actual
			if want == actual {
				item.State = "ok"
				break
			}
			// drift
			if !enforcing {
				item.State = "would-apply"
				break
			}
			if err := io.write(d.Key, want); err != nil {
				item.State = "write-failed"
				item.Error = err.Error()
				snap.Errors = append(snap.Errors, d.Key+": "+err.Error())
				break
			}
			// Re-read to record the value actually in effect post-write.
			if after, ok := io.read(d.Key); ok {
				item.Actual = after
			}
			item.State = "applied"
			snap.AppliedCount++
		}
		snap.Items = append(snap.Items, item)
	}
	return snap
}

// maxSysctlValueLen bounds a written sysctl value — real values are short
// scalars or space-separated tuples; anything larger is rejected.
const maxSysctlValueLen = 1024

// realSysctlIO reads + writes the host's /proc/sys via the <hostRoot>/proc mount.
type realSysctlIO struct {
	hostRoot string
	allow    func(string) bool
}

func newRealSysctlIO(hostRoot string) *realSysctlIO {
	return &realSysctlIO{hostRoot: hostRoot, allow: sysctlAllowed}
}

func (r *realSysctlIO) read(key string) (string, bool) {
	full, ok := hostProcSysPath(r.hostRoot, key)
	if !ok {
		return "", false
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	return normalizeSysctl(string(b)), true
}

// write enforces a sysctl on the host. It REFUSES (returns an error, writes
// nothing) for a non-allow-listed key or a path that would escape /proc/sys —
// the second, independent gate behind converge()'s allow-list check, so a bug
// in the convergence loop can never escalate into an out-of-bounds host write.
func (r *realSysctlIO) write(key, value string) error {
	if !r.allow(key) {
		return fmt.Errorf("refusing to write non-allow-listed sysctl %q", key)
	}
	// A real sysctl value is a short scalar / space-separated tuple. Cap the
	// length so an oversize ConfigMap value can't be force-written into procfs.
	if len(value) > maxSysctlValueLen {
		return fmt.Errorf("refusing oversize sysctl value (%d bytes) for %q", len(value), key)
	}
	full, ok := hostProcSysPath(r.hostRoot, key)
	if !ok {
		return fmt.Errorf("refusing unsafe sysctl path for %q", key)
	}
	// A sysctl takes a single line; the kernel ignores the trailing newline.
	// procfs ignores the file mode + O_TRUNC — this is the `echo v > /proc/sys/x`
	// equivalent.
	if err := os.WriteFile(full, []byte(value+"\n"), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", full, err)
	}
	return nil
}
