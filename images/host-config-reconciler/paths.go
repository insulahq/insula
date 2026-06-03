package main

import (
	"os"
	"path/filepath"
	"strings"
)

// hostProcSysPath maps a dotted sysctl key to its absolute path under
// <hostRoot>/proc/sys, returning ok=false for ANY key that fails the key guards
// (sysctlKeyToPath) OR whose cleaned absolute path would escape <hostRoot>/proc/sys.
// This is the single chokepoint both the observe collector (read) and the
// converge writer (write) funnel through, so neither can be tricked into
// touching a path outside /proc/sys.
func hostProcSysPath(hostRoot, key string) (string, bool) {
	rel, ok := sysctlKeyToPath(key)
	if !ok {
		return "", false
	}
	base := filepath.Join(hostRoot, "proc", "sys")
	full := filepath.Join(base, rel)
	if full != base && !strings.HasPrefix(full, base+string(os.PathSeparator)) {
		return "", false
	}
	return full, true
}
