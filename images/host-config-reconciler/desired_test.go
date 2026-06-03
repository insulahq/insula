package main

import "testing"

func TestParseDesired(t *testing.T) {
	in := `
# comment
; also comment
net.ipv4.ip_forward = 1
vm.max_map_count=262144
   fs.inotify.max_user_watches   =   524288
badline_no_equals
=valueonly
key.only =
`
	cfg := parseDesired(in)
	want := []DesiredSysctl{
		{"net.ipv4.ip_forward", "1"},
		{"vm.max_map_count", "262144"},
		{"fs.inotify.max_user_watches", "524288"},
		{"key.only", ""},
	}
	if len(cfg.Sysctls) != len(want) {
		t.Fatalf("got %d sysctls want %d: %+v", len(cfg.Sysctls), len(want), cfg.Sysctls)
	}
	for i, w := range want {
		if cfg.Sysctls[i] != w {
			t.Errorf("sysctl[%d]=%+v want %+v", i, cfg.Sysctls[i], w)
		}
	}
}

func TestParseDesiredEmpty(t *testing.T) {
	if cfg := parseDesired(""); len(cfg.Sysctls) != 0 {
		t.Errorf("empty input → %d sysctls", len(cfg.Sysctls))
	}
}
