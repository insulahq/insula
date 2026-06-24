package main

import "testing"

// #129: the tenant-ports / peer apply short-circuit now compares the desired
// fingerprint against an IN-MEMORY last-applied fingerprint instead of a
// kernel read-back. The kernel read decoded interval sets and could misread a
// populated set as empty, so the empty-desired REMOVE path matched empty and
// skipped the flush — leaking the deleted members' nft entries indefinitely.
// The in-memory cache correctly sees populated→empty as a change and flushes.

func TestApplyTenantPortsIfChanged_RemoveAfterPopulatedFlushes(t *testing.T) {
	fa := &fakeApplier{}
	r := &reconciler{applier: fa}
	// 1) a pod with ports, then 2) the pod deleted (empty desired).
	if _, err := r.applyTenantPortsIfChanged(tenantPortSets{TCP: []string{"3478"}}); err != nil {
		t.Fatal(err)
	}
	changed, err := r.applyTenantPortsIfChanged(tenantPortSets{}) // REMOVE
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fa.tenantPortCalls) != 2 {
		t.Fatalf("empty desired after a populated state must FLUSH (the remove); changed=%v applyCalls=%d", changed, len(fa.tenantPortCalls))
	}
	last := fa.tenantPortCalls[len(fa.tenantPortCalls)-1]
	if len(last.TCP) != 0 || len(last.UDP) != 0 {
		t.Fatalf("the remove apply must carry an empty set; got tcp=%v udp=%v", last.TCP, last.UDP)
	}
}

func TestApplyTenantPortsIfChanged_RepeatedStateReportsNoChange(t *testing.T) {
	fa := &fakeApplier{}
	r := &reconciler{applier: fa}
	d := tenantPortSets{TCP: []string{"3478"}}
	if _, err := r.applyTenantPortsIfChanged(d); err != nil {
		t.Fatal(err)
	}
	changed, err := r.applyTenantPortsIfChanged(d) // identical state on the next tick
	if err != nil {
		t.Fatal(err)
	}
	// The apply is unconditional (idempotent re-write every tick), but the
	// change SIGNAL must be false so steady state doesn't log on every tick.
	if changed {
		t.Fatalf("repeated identical state must report changed=false (no log); got changed=true")
	}
	if len(fa.tenantPortCalls) != 2 {
		t.Fatalf("apply is unconditional; expected 2 applies, got %d", len(fa.tenantPortCalls))
	}
}

func TestApplyPeersIfChanged_RemoveAfterPopulatedFlushes(t *testing.T) {
	fa := &fakeApplier{}
	r := &reconciler{applier: fa}
	if _, err := r.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}}); err != nil {
		t.Fatal(err)
	}
	changed, err := r.applyPeersIfChanged(peerNftSets{}) // all peers removed
	if err != nil {
		t.Fatal(err)
	}
	if !changed || len(fa.calls) != 2 {
		t.Fatalf("empty peer desired after a populated state must FLUSH; changed=%v applyCalls=%d", changed, len(fa.calls))
	}
}
