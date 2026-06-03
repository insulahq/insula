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

// sysctlDenyList mirrors the host-side converger's deny-list (platform-ops
// host-config/sysctls.ts) so OBSERVE and CONVERGE agree: a dangerous-to-write
// key (kernel.core_pattern root-RCE, hardening downgrades, etc.) is "not-allowed"
// on BOTH sides — the drift surface never reports a key the converger refuses to
// write. Checked before the prefix allow-list. Keep in lockstep with the TS list.
var sysctlDenyList = map[string]bool{
	"kernel.core_pattern":                  true,
	"kernel.modprobe":                      true,
	"kernel.poweroff_cmd":                  true,
	"kernel.hotplug":                       true,
	"kernel.sysrq":                         true,
	"kernel.dmesg_restrict":                true,
	"kernel.kptr_restrict":                 true,
	"kernel.perf_event_paranoid":           true,
	"kernel.unprivileged_bpf_disabled":     true,
	"kernel.yama.ptrace_scope":             true,
	"kernel.randomize_va_space":            true,
	"fs.suid_dumpable":                     true,
	"fs.protected_hardlinks":               true,
	"fs.protected_symlinks":                true,
	"fs.protected_fifos":                   true,
	"fs.protected_regular":                 true,
	"net.ipv4.conf.all.route_localnet":     true,
	"net.ipv4.conf.default.route_localnet": true,
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
	return strings.ReplaceAll(key, ".", "/"), true
}
