package main

import (
	"context"
	"encoding/json"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// convergeOnce wires loadDesired (mode gate) → converge → publishApplied against
// a real-ish (fake) apiserver. It is the gate that ACTUALLY arms host writes, so
// it gets explicit enforce-vs-dry-run coverage end to end.
func runConvergeOnceTest(t *testing.T, mode string) (*fakeIO, AppliedSnapshot) {
	t.Helper()
	ns := "platform-system"
	node := "n1"
	cs := fake.NewSimpleClientset(
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: node}},
		&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: desiredConfigMapName, Namespace: ns},
			Data:       map[string]string{"mode": mode, "sysctls": "vm.max_map_count = 262144\n"},
		},
	)
	io := newFakeIO(map[string]string{"vm.max_map_count": "1"}) // drift
	pub := newConfigMapPublisher(cs, ns, node)
	convergeOnce(context.Background(), cs, ns, node, io, pub, &healthState{})

	cm, err := cs.CoreV1().ConfigMaps(ns).Get(context.Background(), appliedConfigMapName(node), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("applied ConfigMap not written: %v", err)
	}
	var snap AppliedSnapshot
	if err := json.Unmarshal([]byte(cm.Data["applied"]), &snap); err != nil {
		t.Fatalf("applied payload not JSON: %v", err)
	}
	return io, snap
}

func TestConvergeOnce_EnforceWrites(t *testing.T) {
	io, snap := runConvergeOnceTest(t, "enforce")
	if snap.Mode != "enforce" {
		t.Fatalf("snapshot mode=%q want enforce", snap.Mode)
	}
	if !io.wroteKey("vm.max_map_count") {
		t.Fatal("enforce mode did not write the drifting sysctl")
	}
	if snap.AppliedCount != 1 {
		t.Fatalf("appliedCount=%d want 1", snap.AppliedCount)
	}
}

func TestConvergeOnce_DryRunGate(t *testing.T) {
	// Default (absent/observe/dry-run) mode must NOT write, even with drift.
	for _, mode := range []string{"", "dry-run", "observe"} {
		io, snap := runConvergeOnceTest(t, mode)
		if len(io.writes) != 0 {
			t.Fatalf("mode=%q wrote %d times — must be 0 (only data.mode=enforce arms writes)", mode, len(io.writes))
		}
		if snap.Mode != "dry-run" {
			t.Fatalf("mode=%q → snapshot mode=%q want dry-run", mode, snap.Mode)
		}
	}
}

func TestAppliedConfigMapName(t *testing.T) {
	if got := appliedConfigMapName("testing"); got != "host-config-applied-testing" {
		t.Errorf("appliedConfigMapName(testing)=%q", got)
	}
	long := make([]byte, 500)
	for i := range long {
		long[i] = 'n'
	}
	got := appliedConfigMapName(string(long))
	if len(got) > 253 {
		t.Errorf("appliedConfigMapName over-long node → %d chars (>253)", len(got))
	}
}
