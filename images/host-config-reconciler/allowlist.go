package main

import "strings"

// allowedSysctlPrefixes bounds which sysctl namespaces the reconciler will
// inspect, EVEN IF the host-config-desired ConfigMap lists others. In observe
// mode this limits what is READ + reported; it is the same gate write-mode
// will reuse to bound what may be WRITTEN. Conservative: the host-tunable
// namespaces the platform actually manages (net/vm/fs/kernel). A desired key
// outside these is reported with state "not-allowed" and never read.
var allowedSysctlPrefixes = []string{
	"net.",
	"vm.",
	"fs.",
	"kernel.",
}

// sysctlDenyList blocks specific keys that fall WITHIN an allowed prefix but are
// dangerous to ever write — they grant host root code execution or downgrade
// kernel hardening, and the platform never tunes them. Checked BEFORE the prefix
// allow-list, so these are reported "not-allowed" and are never read or written
// in EITHER observe or converge mode (defence against an attacker-influenced
// host-config-desired ConfigMap).
//
//	kernel.core_pattern — a leading "|" makes the kernel exec an arbitrary binary
//	    as ROOT on the next core dump (classic LPE→RCE). THE reason this list exists.
//	fs.suid_dumpable — =2 lets setuid binaries dump core, weaponising core_pattern
//	    without the attacker having to crash their own process.
//	kernel.modprobe / kernel.poweroff_cmd / kernel.hotplug — other kernel-invoked
//	    helper-binary paths → root RCE.
//	kernel.sysrq — can trigger an immediate reboot/panic (host DoS).
//	kernel.{dmesg_restrict,kptr_restrict,perf_event_paranoid,unprivileged_bpf_disabled}
//	    + kernel.yama.ptrace_scope — writing these DOWNGRADES kernel hardening /
//	    leaks kernel addresses, easing local privilege escalation.
//	fs.protected_{hardlinks,symlinks,fifos,regular} — =0 re-opens classic /tmp
//	    TOCTOU symlink/hardlink attacks blocked by default on modern kernels.
//	net.ipv4.conf.all.route_localnet — routes 127.0.0.0/8 from the wire, exposing
//	    loopback-only services.
var sysctlDenyList = map[string]bool{
	"kernel.core_pattern":              true,
	"kernel.modprobe":                  true,
	"kernel.poweroff_cmd":              true,
	"kernel.hotplug":                   true,
	"kernel.sysrq":                     true,
	"kernel.dmesg_restrict":            true,
	"kernel.kptr_restrict":             true,
	"kernel.perf_event_paranoid":       true,
	"kernel.unprivileged_bpf_disabled": true,
	"kernel.yama.ptrace_scope":         true,
	"fs.suid_dumpable":                 true,
	"fs.protected_hardlinks":           true,
	"fs.protected_symlinks":            true,
	"fs.protected_fifos":               true,
	"fs.protected_regular":             true,
	"net.ipv4.conf.all.route_localnet": true,
}

func sysctlAllowed(key string) bool {
	if sysctlDenyList[key] {
		return false
	}
	for _, p := range allowedSysctlPrefixes {
		if strings.HasPrefix(key, p) {
			return true
		}
	}
	return false
}

// sysctlKeyToPath maps a dotted sysctl key (net.ipv4.ip_forward) to its
// /proc/sys-relative path (net/ipv4/ip_forward). Returns ok=false for any key
// that could escape /proc/sys: an embedded slash, a ".." component, a leading
// dot, or emptiness. We deliberately do NOT support the kernel's rare
// inverse mapping (a literal dot inside a name, e.g. "eth0.100") — guessing it
// is unsafe and those keys are out of scope for the managed namespaces.
func sysctlKeyToPath(key string) (string, bool) {
	if key == "" || strings.HasPrefix(key, ".") || strings.HasSuffix(key, ".") {
		// A trailing dot maps to a trailing slash → a directory read (EISDIR),
		// which is never a valid sysctl. Reject it outright.
		return "", false
	}
	if strings.Contains(key, "/") || strings.Contains(key, "..") {
		return "", false
	}
	// Defence in depth: reject any empty dot-component (e.g. "net..ipv4" — already
	// caught by the ".." check, but explicit so a future edit can't reintroduce a
	// `net//ipv4` collapse).
	for _, part := range strings.Split(key, ".") {
		if part == "" {
			return "", false
		}
	}
	return strings.ReplaceAll(key, ".", "/"), true
}
