package main

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeHost builds a throwaway host tree. Helpers below add only the pieces a
// case needs, so each test states exactly the host shape it asserts on.
func fakeHost(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func withBinary(t *testing.T, root, name string) {
	t.Helper()
	dir := filepath.Join(root, "usr/bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write binary: %v", err)
	}
}

func withAptConf(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, "etc/apt/apt.conf.d")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("write apt conf: %v", err)
	}
}

func withTimerEnabled(t *testing.T, root, unit string) {
	t.Helper()
	dir := filepath.Join(root, "etc/systemd/system/timers.target.wants")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, unit), nil, 0o644); err != nil {
		t.Fatalf("write timer link: %v", err)
	}
}

func withDnfAutomaticConf(t *testing.T, root, body string) {
	t.Helper()
	dir := filepath.Join(root, "etc/dnf")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "automatic.conf"), []byte(body), 0o644); err != nil {
		t.Fatalf("write automatic.conf: %v", err)
	}
}

const aptOn = "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n"
const aptOff = "APT::Periodic::Unattended-Upgrade \"0\";\n"

// THE REGRESSION. This is the exact production shape on 2026-09-11: the stock
// apt timers enabled and firing daily, no unattended-upgrades package, no
// periodic knob — 20 pending security updates. The previous implementation
// looked only for a binary, so it reported... also false here. What it got
// WRONG was the opposite direction (see the next two tests); this case pins the
// headline behaviour so a future "simplification" back to a presence check
// can't quietly re-pass it.
func TestUnattendedUpgrades_ProductionShape_TimersButNoPackage(t *testing.T) {
	root := fakeHost(t)
	withTimerEnabled(t, root, "apt-daily.timer")
	withTimerEnabled(t, root, "apt-daily-upgrade.timer")
	if unattendedUpgradesActive(root) {
		t.Fatal("timers enabled but no unattended-upgrades package and no periodic knob — must NOT report active")
	}
}

// The false-green the old check produced: binary installed, nothing configured.
func TestUnattendedUpgrades_BinaryAloneIsNotActive(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	if unattendedUpgradesActive(root) {
		t.Fatal("a present binary with no periodic knob and no timer patches nothing — must NOT report active")
	}
}

// Installed + configured, but the timer that runs it is not enabled.
func TestUnattendedUpgrades_ConfiguredButTimerDisabled(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withAptConf(t, root, "20auto-upgrades", aptOn)
	if unattendedUpgradesActive(root) {
		t.Fatal("no apt-daily-upgrade.timer means nothing ever runs — must NOT report active")
	}
}

func TestUnattendedUpgrades_FullyConfiguredApt(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withAptConf(t, root, "20auto-upgrades", aptOn)
	withTimerEnabled(t, root, "apt-daily-upgrade.timer")
	if !unattendedUpgradesActive(root) {
		t.Fatal("package + periodic knob + enabled timer is the configured state — must report active")
	}
}

// apt reads apt.conf.d in lexical order and the LAST assignment wins, so a 99-
// file turning it off must beat the 20- file turning it on. Stopping at the
// first match would report a machine as patching when it is not.
func TestUnattendedUpgrades_LastAssignmentWins_Disable(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withTimerEnabled(t, root, "apt-daily-upgrade.timer")
	withAptConf(t, root, "20auto-upgrades", aptOn)
	withAptConf(t, root, "99-operator-disable", aptOff)
	if unattendedUpgradesActive(root) {
		t.Fatal("99- file sets the knob to 0 and wins over 20- — must NOT report active")
	}
}

func TestUnattendedUpgrades_LastAssignmentWins_Enable(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withTimerEnabled(t, root, "apt-daily-upgrade.timer")
	withAptConf(t, root, "20auto-upgrades", aptOff)
	withAptConf(t, root, "99-operator-enable", aptOn)
	if !unattendedUpgradesActive(root) {
		t.Fatal("99- file re-enables the knob and wins over 20- — must report active")
	}
}

// A commented-out assignment is not an assignment.
func TestUnattendedUpgrades_CommentedKnobIgnored(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withTimerEnabled(t, root, "apt-daily-upgrade.timer")
	withAptConf(t, root, "20auto-upgrades", "// APT::Periodic::Unattended-Upgrade \"1\";\n")
	if unattendedUpgradesActive(root) {
		t.Fatal("the only assignment is commented out — must NOT report active")
	}
}

// The vendor-preset location counts as enabled too, not just /etc.
func TestUnattendedUpgrades_VendorPresetTimerCounts(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "unattended-upgrade")
	withAptConf(t, root, "20auto-upgrades", aptOn)
	dir := filepath.Join(root, "usr/lib/systemd/system/timers.target.wants")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "apt-daily-upgrade.timer"), nil, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !unattendedUpgradesActive(root) {
		t.Fatal("a vendor-preset timer want is still enabled — must report active")
	}
}

func TestDnfAutomatic_FullyConfigured(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "dnf-automatic")
	withDnfAutomaticConf(t, root, "[commands]\nupgrade_type = security\napply_updates = yes\nreboot = never\n")
	withTimerEnabled(t, root, "dnf-automatic.timer")
	if !unattendedUpgradesActive(root) {
		t.Fatal("dnf-automatic installed, applying and timed — must report active")
	}
}

func TestDnfAutomatic_ApplyUpdatesNo(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "dnf-automatic")
	withDnfAutomaticConf(t, root, "[commands]\napply_updates = no\n")
	withTimerEnabled(t, root, "dnf-automatic.timer")
	if unattendedUpgradesActive(root) {
		t.Fatal("apply_updates = no downloads but never installs — must NOT report active")
	}
}

// Older builds shipped dnf-automatic-install.timer instead.
func TestDnfAutomatic_LegacyTimerName(t *testing.T) {
	root := fakeHost(t)
	withBinary(t, root, "dnf-automatic")
	withDnfAutomaticConf(t, root, "[commands]\napply_updates = yes\n")
	withTimerEnabled(t, root, "dnf-automatic-install.timer")
	if !unattendedUpgradesActive(root) {
		t.Fatal("dnf-automatic-install.timer is the legacy unit name — must report active")
	}
}

func TestUnattendedUpgrades_EmptyHostIsNotActive(t *testing.T) {
	if unattendedUpgradesActive(fakeHost(t)) {
		t.Fatal("an empty host root must NOT report active")
	}
}

// The finding must say what it checks. It previously read "installed" while the
// field was named ...Active, which is how a host with 20 pending security
// updates looked fine.
func TestCISFinding_HARDEN002_TitleAndVerdict(t *testing.T) {
	ssh := sshView("no", "no", "no", []string{"admin"}, true)
	h := Hardening{TimeSinceRebootSecs: 1000, Fail2banPresent: true, UnattendedUpgradesActive: false}
	findings := buildCISFindings(ssh, h, false)
	var f *CISFinding
	for i := range findings {
		if findings[i].ID == "HARDEN-002" {
			f = &findings[i]
			break
		}
	}
	if f == nil {
		t.Fatal("HARDEN-002 missing from findings")
	}
	if f.Passing {
		t.Fatal("UnattendedUpgradesActive=false must not pass")
	}
	if f.Title == "unattended-upgrades / dnf-automatic installed" {
		t.Fatal("title still claims 'installed' — it must describe the behaviour actually checked")
	}
}
