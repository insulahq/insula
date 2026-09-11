package main

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// collectHardening assembles the CIS-style snapshot from host reads.
// All host paths are resolved under hostRoot to keep tests
// hermetic.
//
// CIS findings here are the Phase 1 hand-picked subset (≤10 rules).
func collectHardening(hostRoot string, ssh sshConfigView, ssh22Public bool) Hardening {
	h := Hardening{
		KernelVersion: readKernelVersion(hostRoot),
		OSPretty:      readOSPretty(hostRoot),
	}
	h.TimeSinceRebootSecs = bootAgeSeconds(hostRoot)
	h.Fail2banPresent = anyBinaryPresent(hostRoot, "fail2ban-server", "fail2ban-client")
	h.SshguardPresent = anyBinaryPresent(hostRoot, "sshguard")
	h.UnattendedUpgradesActive = unattendedUpgradesActive(hostRoot)
	h.AutomaticRebootWindow = nil
	h.PendingKernelUpdate = pendingKernelUpdate(hostRoot)
	h.KernelEOL = false

	h.CISFindings = buildCISFindings(ssh, h, ssh22Public)
	return h
}

func readKernelVersion(hostRoot string) string {
	b, err := os.ReadFile(filepath.Join(hostRoot, "proc/sys/kernel/osrelease"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readOSPretty(hostRoot string) string {
	f, err := os.Open(filepath.Join(hostRoot, "etc/os-release"))
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			v := strings.TrimPrefix(line, "PRETTY_NAME=")
			v = strings.TrimSpace(v)
			v = strings.Trim(v, "\"'")
			return v
		}
	}
	return ""
}

// bootAgeSeconds reads /proc/stat for `btime <epoch>` which is the
// system boot time. Returns 0 on read or parse failure.
func bootAgeSeconds(hostRoot string) int64 {
	b, err := os.ReadFile(filepath.Join(hostRoot, "proc/stat"))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			parts := strings.Fields(line)
			if len(parts) != 2 {
				return 0
			}
			ts, err := strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				return 0
			}
			age := time.Now().Unix() - ts
			if age < 0 {
				return 0
			}
			return age
		}
	}
	return 0
}

// anyBinaryPresent checks /usr/sbin and /usr/bin under hostRoot for
// any of the given binary names. Returns true on the first hit.
// Doesn't `stat` — `Lstat` is enough to detect symlinks to the
// binary as well as the binary itself.
func anyBinaryPresent(hostRoot string, names ...string) bool {
	for _, dir := range []string{"usr/sbin", "usr/bin"} {
		for _, n := range names {
			p := filepath.Join(hostRoot, dir, n)
			if _, err := os.Lstat(p); err == nil {
				return true
			}
		}
	}
	return false
}

// unattendedUpgradesActive reports whether this host is actually configured to
// INSTALL OS security updates on a timer.
//
// It used to check only whether a binary existed, with a comment excusing that
// as "a useful first signal". It was not: on the production node the binary was
// absent while apt-daily.timer and apt-daily-upgrade.timer were enabled, active
// and firing daily — installing nothing, because APT::Periodic::Unattended-
// Upgrade was unset and the package was never installed. 20 pending security
// updates accumulated behind a check named "...Active" that never looked at
// whether anything was active. The inverse is just as wrong: an installed
// binary with the periodic knob set to "0" reports healthy while patching
// nothing.
//
// `systemctl is-enabled` is still unavailable (read-only mount, no exec), but
// enablement does not need it — a systemd timer is enabled iff a symlink for it
// exists under a timers.target.wants directory, which is plainly readable.
func unattendedUpgradesActive(hostRoot string) bool {
	return aptUnattendedActive(hostRoot) || dnfAutomaticActive(hostRoot)
}

// hostPathsForAutoUpdateCheck is every host path unattendedUpgradesActive reads,
// relative to hostRoot.
//
// The DaemonSet mounts an ALLOWLIST of host paths. A path that is not mounted
// does not read as an error — it reads as ABSENT, so the check reports false on
// every node forever and looks like a real finding. That is not hypothetical:
// the first deployment of this rewrite did exactly that, because apt.conf.d and
// the timers.target.wants directories were not mounted. Hermetic tests cannot
// catch it (they build their own root), so daemonset_mounts_test.go asserts this
// list against the committed manifest. Add a read here AND a mount there.
var hostPathsForAutoUpdateCheck = []string{
	"usr/bin",
	"usr/sbin",
	"etc/apt/apt.conf.d",
	"etc/dnf",
	"etc/systemd/system/timers.target.wants",
	"usr/lib/systemd/system/timers.target.wants",
	// KERNEL-002 — see pendingKernelUpdate.
	"usr/lib/modules",
}

// pendingKernelUpdate reports whether a kernel NEWER than the running one is
// installed, i.e. rebooting would change the running kernel.
//
// KERNEL-002 ("No pending kernel update") was `Passing: !h.PendingKernelUpdate`
// over a field hardcoded to false, so it was PERMANENTLY GREEN. That mattered
// little while nothing installed kernels; now that security updates install
// automatically, a node can pick up a kernel and sit on the old one
// indefinitely — the platform deliberately never reboots — with the panel
// reporting no pending update.
//
// NOT read from /var/run/reboot-required, despite that being the obvious
// source. Two blockers, both measured on the production node 2026-09-11:
//   - the file is EMPTY (0 bytes; the text lives in reboot-required.pkgs), so a
//     hostPath `FileOrCreate` mount is byte-identical to the real flag and
//     every node would report a pending reboot forever;
//   - reading it without creating it means mounting its parent, /run, which
//     holds `credentials` and `secrets` — material this DaemonSet deliberately
//     cannot see.
//
// Comparing installed against running is also a closer match for a field named
// pendingKernelUpdate: reboot-required is set for any reason, not just kernels.
//
// An installed kernel is identified by a modules tree WITH a kernel/ subdir.
// A removed kernel leaves modules.dep behind but not kernel/ — on production
// 6.12.94 (auto-removed) still had modules.dep, so keying on that alone would
// count kernels that are gone.
func pendingKernelUpdate(hostRoot string) bool {
	running := readKernelVersion(hostRoot)
	if running == "" {
		return false
	}
	newest := newestInstalledKernel(hostRoot)
	if newest == "" {
		return false
	}
	return compareVersionStrings(newest, running) > 0
}

func newestInstalledKernel(hostRoot string) string {
	newest := ""
	for _, base := range []string{"usr/lib/modules", "lib/modules"} {
		entries, err := os.ReadDir(filepath.Join(hostRoot, base))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			// kernel/ present ⇒ the kernel package is installed, not merely
			// a leftover modules directory from a removed one.
			if _, err := os.Stat(filepath.Join(hostRoot, base, e.Name(), "kernel")); err != nil {
				continue
			}
			if newest == "" || compareVersionStrings(e.Name(), newest) > 0 {
				newest = e.Name()
			}
		}
	}
	return newest
}

// compareVersionStrings compares release strings like "6.12.107+deb13-amd64" or
// "5.14.0-503.el9.x86_64" by splitting into digit and non-digit runs and
// comparing digit runs NUMERICALLY. A plain string compare gets 6.12.99 vs
// 6.12.101 backwards, which is the exact shape of a Debian point release.
func compareVersionStrings(a, b string) int {
	ta, tb := versionTokens(a), versionTokens(b)
	for i := 0; i < len(ta) && i < len(tb); i++ {
		x, y := ta[i], tb[i]
		xn, xErr := strconv.Atoi(x)
		yn, yErr := strconv.Atoi(y)
		if xErr == nil && yErr == nil {
			if xn != yn {
				if xn > yn {
					return 1
				}
				return -1
			}
			continue
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	switch {
	case len(ta) > len(tb):
		return 1
	case len(ta) < len(tb):
		return -1
	}
	return 0
}

func versionTokens(s string) []string {
	var out []string
	i := 0
	for i < len(s) {
		j := i
		isDigit := s[i] >= '0' && s[i] <= '9'
		for j < len(s) && ((s[j] >= '0' && s[j] <= '9') == isDigit) {
			j++
		}
		tok := s[i:j]
		// Separators carry no ordering information of their own.
		if tok != "." && tok != "-" && tok != "+" && tok != "_" {
			out = append(out, tok)
		}
		i = j
	}
	return out
}

// aptUnattendedActive: package installed AND the periodic knob on AND the timer
// that runs it enabled. All three are required — any one alone patches nothing.
func aptUnattendedActive(hostRoot string) bool {
	if !anyBinaryPresent(hostRoot, "unattended-upgrade", "unattended-upgrades") {
		return false
	}
	if !aptPeriodicUnattendedEnabled(hostRoot) {
		return false
	}
	return systemdTimerEnabled(hostRoot, "apt-daily-upgrade.timer")
}

// aptPeriodicUnattendedEnabled scans /etc/apt/apt.conf.d for
// APT::Periodic::Unattended-Upgrade and returns true when the winning value is
// non-zero.
//
// apt reads that directory in lexical order and LAST ASSIGNMENT WINS, so this
// must not stop at the first hit: a 99- file setting "0" legitimately disables
// what 20auto-upgrades turned on, and reporting the 20- value would be a false
// green. Files are sorted and every match is taken, keeping the last.
func aptPeriodicUnattendedEnabled(hostRoot string) bool {
	dir := filepath.Join(hostRoot, "etc/apt/apt.conf.d")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	found, enabled := false, false
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "//") || strings.HasPrefix(line, "#") {
				continue
			}
			if !strings.Contains(line, "APT::Periodic::Unattended-Upgrade") {
				continue
			}
			// APT::Periodic::Unattended-Upgrade "1";
			v := line
			if i := strings.Index(v, "APT::Periodic::Unattended-Upgrade"); i >= 0 {
				v = v[i+len("APT::Periodic::Unattended-Upgrade"):]
			}
			v = strings.Trim(strings.TrimSpace(v), ";")
			v = strings.Trim(strings.TrimSpace(v), "\"'")
			found = true
			enabled = v != "" && v != "0"
		}
	}
	return found && enabled
}

// dnfAutomaticActive: binary installed AND apply_updates=yes AND a
// dnf-automatic timer enabled. RHEL 9 / AL2023 ship dnf-automatic.timer; older
// builds used dnf-automatic-install.timer, so either counts.
func dnfAutomaticActive(hostRoot string) bool {
	if !anyBinaryPresent(hostRoot, "dnf-automatic") {
		return false
	}
	if !iniKeyEquals(filepath.Join(hostRoot, "etc/dnf/automatic.conf"), "apply_updates", "yes") {
		return false
	}
	return systemdTimerEnabled(hostRoot, "dnf-automatic.timer") ||
		systemdTimerEnabled(hostRoot, "dnf-automatic-install.timer")
}

// iniKeyEquals reports whether an ini-style file assigns key the given value.
// Last assignment wins, matching how these parsers behave.
func iniKeyEquals(path, key, want string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	got := ""
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), key) {
			continue
		}
		got = strings.TrimSpace(v)
	}
	return strings.EqualFold(got, want)
}

// systemdTimerEnabled reports whether unit is enabled, by the same rule
// `systemctl is-enabled` applies for a static-target want: a symlink (or file)
// named after the unit under a timers.target.wants directory. Both the admin
// location (/etc/systemd/system) and the vendor-preset one (/usr/lib/...) count.
func systemdTimerEnabled(hostRoot, unit string) bool {
	for _, base := range []string{
		"etc/systemd/system/timers.target.wants",
		"usr/lib/systemd/system/timers.target.wants",
		"lib/systemd/system/timers.target.wants",
	} {
		if _, err := os.Lstat(filepath.Join(hostRoot, base, unit)); err == nil {
			return true
		}
	}
	return false
}

// buildCISFindings encodes the Phase 1 ≤10 rules. Each rule's
// (passing, observed, expected) is derived from the inputs only —
// no further IO — so this function is trivial to unit-test.
func buildCISFindings(ssh sshConfigView, h Hardening, ssh22Public bool) []CISFinding {
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	findings := []CISFinding{
		{
			ID:       "SSH-001",
			Severity: "high",
			Title:    "PermitRootLogin should be no",
			Observed: orParseError(ssh, deref(ssh.flags.PermitRootLogin)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.PermitRootLogin), "no"),
		},
		{
			ID:       "SSH-002",
			Severity: "high",
			Title:    "PasswordAuthentication should be no",
			Observed: orParseError(ssh, deref(ssh.flags.PasswordAuthentication)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.PasswordAuthentication), "no"),
		},
		{
			ID:       "SSH-003",
			Severity: "medium",
			Title:    "AllowUsers whitelist set",
			Observed: orParseError(ssh, strings.Join(ssh.flags.AllowUsers, " ")),
			Expected: "non-empty list",
			Passing:  ssh.parsed && len(ssh.flags.AllowUsers) > 0,
		},
		{
			ID:       "SSH-004",
			Severity: "info",
			Title:    "Port is non-default (security by obscurity, informational)",
			Observed: strconv.Itoa(ssh.flags.Port),
			Expected: "≠ 22",
			Passing:  ssh.flags.Port != 22,
		},
		{
			ID:       "SSH-005",
			Severity: "medium",
			Title:    "KbdInteractiveAuthentication should be no",
			Observed: orParseError(ssh, deref(ssh.flags.KbdInteractiveAuthentication)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.KbdInteractiveAuthentication), "no"),
		},
		{
			ID:       "KERNEL-001",
			Severity: "medium",
			Title:    "Boot age within 90 days",
			Observed: formatBootAge(h.TimeSinceRebootSecs),
			Expected: "< 90d",
			Passing:  h.TimeSinceRebootSecs > 0 && h.TimeSinceRebootSecs < 90*24*3600,
		},
		{
			ID:       "KERNEL-002",
			Severity: "medium",
			Title:    "No pending kernel update",
			Observed: boolStr(h.PendingKernelUpdate),
			Expected: "false",
			Passing:  !h.PendingKernelUpdate,
		},
		{
			ID:       "HARDEN-001",
			Severity: "medium",
			Title:    "fail2ban or sshguard present",
			Observed: boolStr(h.Fail2banPresent || h.SshguardPresent),
			Expected: "true",
			Passing:  h.Fail2banPresent || h.SshguardPresent,
		},
		{
			ID:       "HARDEN-002",
			Severity: "medium",
			Title:    "OS security updates install automatically",
			Observed: boolStr(h.UnattendedUpgradesActive),
			Expected: "true",
			Passing:  h.UnattendedUpgradesActive,
		},
		{
			ID:       "NET-001",
			Severity: "critical",
			Title:    "SSH not exposed to 0.0.0.0/0",
			Observed: ifTrueElse(ssh22Public, "public (any IP can connect on :22)", "scoped"),
			Expected: "scoped (mesh or trusted_ranges only)",
			Passing:  !ssh22Public,
		},
	}
	return findings
}

func orParseError(ssh sshConfigView, v string) string {
	if !ssh.parsed {
		return "(sshd_config parse failed)"
	}
	if v == "" {
		return "(unset)"
	}
	return v
}

func formatBootAge(secs int64) string {
	if secs <= 0 {
		return "unknown"
	}
	d := time.Duration(secs) * time.Second
	return d.Truncate(time.Hour).String()
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func ifTrueElse(b bool, t, f string) string {
	if b {
		return t
	}
	return f
}
