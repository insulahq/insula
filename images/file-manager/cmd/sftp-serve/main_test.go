package main

import "testing"

// confineStart is the only pure, tenant-influenced input path in sftp-serve, so
// it gets table-driven coverage. The chroot is the real boundary — these cases
// exist so a bad `-d` can never even pick a silly starting directory, and so a
// future refactor cannot quietly reintroduce traversal.
//
// Note every escape attempt collapses INSIDE the jail: filepath.Clean on an
// absolute path can never produce a result above "/", so the worst a caller can
// do is name a directory the tenant owns.
func TestConfineStart(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty → root", "", "/"},
		{"root stays root", "/", "/"},
		{"plain subdir", "/public_html", "/public_html"},
		{"subdir without leading slash", "public_html", "/public_html"},
		{"nested subdir", "/public_html/uploads", "/public_html/uploads"},
		{"trailing slash normalised", "/public_html/", "/public_html"},

		// Traversal — all clamp to a path inside the jail, never above it.
		{"leading traversal", "../../../etc", "/etc"},
		{"absolute traversal", "/../../../etc", "/etc"},
		{"traversal from subdir", "/public_html/../../..", "/"},
		{"bare dotdot", "..", "/"},
		{"dot-dotdot mix", "/./../.", "/"},
		{"single dot", ".", "/"},

		// Null byte — reject outright rather than let it reach a syscall.
		{"null byte", "/public_html\x00/etc", "/"},
		{"null byte alone", "\x00", "/"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := confineStart(tc.in); got != tc.want {
				t.Errorf("confineStart(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// confineStart must never return a path that escapes the jail root — i.e. it is
// always absolute and never begins with "..". This is the invariant that
// matters; the table above pins the specific cases.
func TestConfineStartNeverEscapes(t *testing.T) {
	adversarial := []string{
		"..", "../", "../..", "/../..", "....//....//",
		"/public_html/../../../../../../etc/passwd",
		"\x00", "/\x00/..", "./../.", "//../..//",
	}
	for _, in := range adversarial {
		got := confineStart(in)
		if len(got) == 0 || got[0] != '/' {
			t.Errorf("confineStart(%q) = %q — not absolute", in, got)
		}
		if len(got) >= 2 && got[:2] == ".." {
			t.Errorf("confineStart(%q) = %q — escapes root", in, got)
		}
		for i := 0; i < len(got); i++ {
			if got[i] == 0 {
				t.Errorf("confineStart(%q) = %q — contains a null byte", in, got)
			}
		}
	}
}
