package main

import (
	"strings"
	"testing"
)

func TestConfigMapName(t *testing.T) {
	if got := configMapName("testing"); got != "host-config-drift-testing" {
		t.Errorf("configMapName(testing)=%q", got)
	}
	// A pathologically long node name must still yield a ≤253-char k8s name.
	long := strings.Repeat("n", 500)
	got := configMapName(long)
	if len(got) > 253 {
		t.Errorf("configMapName over-long node → %d chars (>253)", len(got))
	}
	if !strings.HasPrefix(got, "host-config-drift-") {
		t.Errorf("configMapName lost its prefix: %q", got[:30])
	}
}
