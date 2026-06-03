package main

import "testing"

func TestSysctlAllowed(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"net.ipv4.ip_forward", true},
		{"vm.max_map_count", true},
		{"fs.inotify.max_user_watches", true},
		{"kernel.pid_max", true},
		{"user.max_user_namespaces", false},
		{"dev.foo.bar", false},
		{"", false},
		{"netfoo.bar", false}, // prefix is "net." not "net"
		// Deny-list: dangerous keys WITHIN an allowed prefix must be refused.
		{"kernel.core_pattern", false},              // root RCE on core dump
		{"kernel.modprobe", false},                  // root RCE
		{"kernel.poweroff_cmd", false},              // root RCE
		{"kernel.hotplug", false},                   // root RCE
		{"kernel.sysrq", false},                     // reboot/panic DoS
		{"kernel.dmesg_restrict", false},            // hardening downgrade
		{"kernel.unprivileged_bpf_disabled", false}, // hardening downgrade
		{"kernel.yama.ptrace_scope", false},         // hardening downgrade
		{"fs.suid_dumpable", false},                 // core_pattern amplifier
		{"fs.protected_symlinks", false},            // /tmp TOCTOU re-enable
		{"net.ipv4.conf.all.route_localnet", false}, // loopback exposure
		// ...but a benign neighbour of a denied key stays allowed.
		{"kernel.pid_max", true},
		{"fs.protected_something_else", true}, // not an exact deny-list match
	}
	for _, c := range cases {
		if got := sysctlAllowed(c.key); got != c.want {
			t.Errorf("sysctlAllowed(%q)=%v want %v", c.key, got, c.want)
		}
	}
}

func TestSysctlKeyToPath(t *testing.T) {
	cases := []struct {
		key  string
		path string
		ok   bool
	}{
		{"net.ipv4.ip_forward", "net/ipv4/ip_forward", true},
		{"vm.max_map_count", "vm/max_map_count", true},
		{"fs.file-max", "fs/file-max", true},
		{"../../etc/passwd", "", false}, // contains ".." and "/"
		{"net/ipv4/ip_forward", "", false}, // contains "/"
		{".hidden", "", false}, // leading dot
		{"net.ipv4.", "", false}, // trailing dot → would read a directory
		{"", "", false},
		{"a..b", "", false}, // contains ".."
	}
	for _, c := range cases {
		p, ok := sysctlKeyToPath(c.key)
		if ok != c.ok || p != c.path {
			t.Errorf("sysctlKeyToPath(%q)=(%q,%v) want (%q,%v)", c.key, p, ok, c.path, c.ok)
		}
	}
}
