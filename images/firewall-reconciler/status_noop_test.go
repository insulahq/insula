package main

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

var noopNow = time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// readyStatus builds a status map shaped like an informer-decoded CTR status.
func readyStatus(gen any, reason, syncedAt, condTime string) map[string]any {
	s := map[string]any{
		"observedGeneration": gen,
		"normalizedCidr":     "198.51.100.0/24",
		"family":             "v4",
		"conditions": []any{map[string]any{
			"type": "Ready", "status": "True", "reason": reason,
			"message": "trust range present in nft set", "lastTransitionTime": condTime,
		}},
	}
	if syncedAt != "" {
		s["lastSyncedAt"] = syncedAt
	}
	return s
}

func readyPayload(gen int64, reason string, now time.Time) statusPayload {
	return statusPayload{
		ObservedGeneration: gen,
		NormalizedCidr:     "198.51.100.0/24",
		Family:             "v4",
		LastSyncedAt:       now,
		Conditions: []condition{{
			Type: "Ready", Status: "True", Reason: reason,
			Message: "trust range present in nft set", Time: now,
		}},
	}
}

func TestStatusPatchIsNoop(t *testing.T) {
	fresh := rfc(noopNow.Add(-90 * time.Second))
	stale := rfc(noopNow.Add(-6 * time.Minute))
	oldCond := rfc(noopNow.Add(-48 * time.Hour))

	failurePayload := statusPayload{
		ObservedGeneration: 1,
		Conditions: []condition{{
			Type: "Ready", Status: "False", Reason: "MissingSpec",
			Message: "spec.cidr is empty or missing", Time: noopNow,
		}},
	}
	failureExisting := map[string]any{
		"observedGeneration": int64(1),
		"lastSyncedAt":       stale, // left over from an earlier success — not ours to refresh
		"conditions": []any{map[string]any{
			"type": "Ready", "status": "False", "reason": "MissingSpec",
			"message": "spec.cidr is empty or missing", "lastTransitionTime": oldCond,
		}},
	}

	cases := []struct {
		name     string
		existing map[string]any
		payload  statusPayload
		wantNoop bool
	}{
		{"no status yet → write", nil, readyPayload(1, "Synced", noopNow), false},
		{"equal + fresh lastSyncedAt → skip", readyStatus(int64(1), "Synced", fresh, oldCond), readyPayload(1, "Synced", noopNow), true},
		{"generation as float64 (JSON decode) still equal → skip", readyStatus(float64(1), "Synced", fresh, oldCond), readyPayload(1, "Synced", noopNow), true},
		{"changed reason → write", readyStatus(int64(1), "Pending", fresh, oldCond), readyPayload(1, "Synced", noopNow), false},
		{"changed observedGeneration → write", readyStatus(int64(1), "Synced", fresh, oldCond), readyPayload(2, "Synced", noopNow), false},
		{"stale lastSyncedAt → write", readyStatus(int64(1), "Synced", stale, oldCond), readyPayload(1, "Synced", noopNow), false},
		{"missing lastSyncedAt → write", readyStatus(int64(1), "Synced", "", oldCond), readyPayload(1, "Synced", noopNow), false},
		{"garbage lastSyncedAt → write", readyStatus(int64(1), "Synced", "yesterday", oldCond), readyPayload(1, "Synced", noopNow), false},
		{"far-future lastSyncedAt → write", readyStatus(int64(1), "Synced", rfc(noopNow.Add(time.Hour)), oldCond), readyPayload(1, "Synced", noopNow), false},
		{"small clock skew (future by 3s) → skip", readyStatus(int64(1), "Synced", rfc(noopNow.Add(3*time.Second)), oldCond), readyPayload(1, "Synced", noopNow), true},
		{"payload without lastSyncedAt, equal → skip regardless of age", failureExisting, failurePayload, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			desired := renderStatus(tc.payload, existingConditions(tc.existing))
			if got := statusPatchIsNoop(tc.existing, desired, tc.payload.LastSyncedAt); got != tc.wantNoop {
				t.Errorf("statusPatchIsNoop = %v, want %v", got, tc.wantNoop)
			}
		})
	}
}

func TestStatusPatchIsNoop_ignoresKeysThePatchDoesNotWrite(t *testing.T) {
	// A claimed CPP carries claimedAt; the regular patchCPPStatus payload
	// does not write it, and a merge patch would leave it alone.
	existing := map[string]any{
		"observedGeneration": int64(1),
		"normalizedIp":       "10.0.0.5/32",
		"family":             "v4",
		"expiresAt":          rfc(noopNow.Add(time.Hour)),
		"claimedAt":          rfc(noopNow.Add(-time.Minute)),
		"conditions": []any{map[string]any{
			"type": "Ready", "status": "True", "reason": "Pending",
			"message": "awaiting node InternalIP match", "lastTransitionTime": rfc(noopNow.Add(-time.Hour)),
		}},
	}
	exp := noopNow.Add(time.Hour)
	p := statusPayload{
		ObservedGeneration: 1, NormalizedIp: "10.0.0.5/32", Family: "v4", ExpiresAt: &exp,
		Conditions: []condition{{Type: "Ready", Status: "True", Reason: "Pending",
			Message: "awaiting node InternalIP match", Time: noopNow}},
	}
	if !statusPatchIsNoop(existing, renderStatus(p, existingConditions(existing)), p.LastSyncedAt) {
		t.Fatal("extra existing keys the patch does not touch must not force a write")
	}
}

func TestStatusPatchIsNoop_conditionCountChange(t *testing.T) {
	existing := readyStatus(int64(1), "Synced", rfc(noopNow), rfc(noopNow))
	p := readyPayload(1, "Synced", noopNow)
	p.Conditions = append(p.Conditions, condition{Type: "Claimed", Status: "True", Reason: "X", Message: "y", Time: noopNow})
	if statusPatchIsNoop(existing, renderStatus(p, existingConditions(existing)), noopNow) {
		t.Fatal("an added condition must force a write")
	}
}

func TestRenderConditions_carriesTransitionTime(t *testing.T) {
	old := rfc(noopNow.Add(-72 * time.Hour))
	prev := []map[string]any{{
		"type": "Ready", "status": "True", "reason": "Synced",
		"message": "trust range present in nft set", "lastTransitionTime": old,
	}}
	unchanged := condition{Type: "Ready", Status: "True", Reason: "Synced", Message: "trust range present in nft set", Time: noopNow}
	if got := renderConditions([]condition{unchanged}, prev)[0]["lastTransitionTime"]; got != old {
		t.Errorf("unchanged condition: lastTransitionTime = %v, want carried %s", got, old)
	}
	for _, changed := range []condition{
		{Type: "Ready", Status: "False", Reason: "Synced", Message: unchanged.Message, Time: noopNow},
		{Type: "Ready", Status: "True", Reason: "Other", Message: unchanged.Message, Time: noopNow},
		{Type: "Ready", Status: "True", Reason: "Synced", Message: "different", Time: noopNow},
	} {
		if got := renderConditions([]condition{changed}, prev)[0]["lastTransitionTime"]; got != rfc(noopNow) {
			t.Errorf("changed condition %+v: lastTransitionTime = %v, want now %s", changed, got, rfc(noopNow))
		}
	}
	if got := renderConditions([]condition{unchanged}, nil)[0]["lastTransitionTime"]; got != rfc(noopNow) {
		t.Errorf("no previous condition: lastTransitionTime = %v, want now", got)
	}
}

// countStatusPatches counts PATCH actions against a status subresource.
func countStatusPatches(dyn *dynamicfake.FakeDynamicClient) int {
	n := 0
	for _, a := range dyn.Actions() {
		if a.GetVerb() == "patch" && a.GetSubresource() == "status" {
			n++
		}
	}
	return n
}

// TestReconcileOnce_statusWritesConverge drives the real reconcile path:
// the first pass writes every status, a second pass over the written objects
// (what the informer would then hold) writes NOTHING, and a pass after the
// refresh interval rewrites lastSyncedAt without moving the condition time.
func TestReconcileOnce_statusWritesConverge(t *testing.T) {
	ctx := context.Background()
	ctrs := []*unstructured.Unstructured{mkCTR("office", "198.51.100.0/24", 1), mkCTR("bogus", "not-a-cidr", 1)}
	cpps := []*unstructured.Unstructured{mkCPP("pending", "10.0.0.5", "worker", 1800, 60, noopNow, 1)}
	cfbs := []*unstructured.Unstructured{mkCFB("hostile", "45.148.10.240", 1)}

	r, _, dyn := fakeReconcilerSetup(t, noopNow, nil, ctrs, cpps, cfbs)
	if err := r.reconcileOnce(ctx); err != nil {
		t.Fatalf("first reconcileOnce: %v", err)
	}
	if got := countStatusPatches(dyn); got != 4 {
		t.Fatalf("first pass: %d status patches, want 4 (2 CTR + 1 CPP + 1 CFB)", got)
	}

	// What the informer would hold after the first pass's writes.
	written := func(list []*unstructured.Unstructured, gvr schema.GroupVersionResource) []*unstructured.Unstructured {
		out := make([]*unstructured.Unstructured, 0, len(list))
		for _, o := range list {
			res, err := dyn.Resource(gvr).Get(ctx, o.GetName(), metav1.GetOptions{})
			if err != nil {
				t.Fatalf("get %s: %v", o.GetName(), err)
			}
			out = append(out, res)
		}
		return out
	}
	ctrs2, cpps2, cfbs2 := written(ctrs, ctrGVR), written(cpps, cppGVR), written(cfbs, cfbGVR)

	// Second pass 30 s later over the written state → zero writes.
	r2, _, dyn2 := fakeReconcilerSetup(t, noopNow.Add(30*time.Second), nil, ctrs2, cpps2, cfbs2)
	if err := r2.reconcileOnce(ctx); err != nil {
		t.Fatalf("second reconcileOnce: %v", err)
	}
	if got := countStatusPatches(dyn2); got != 0 {
		t.Fatalf("second pass: %d status patches, want 0 — unchanged status must not be re-written", got)
	}

	// Third pass after the refresh interval → the lastSyncedAt carriers
	// (healthy CTR + CFB) are refreshed; the failed CTR and the CPP (no
	// lastSyncedAt in their payload) stay untouched.
	later := noopNow.Add(statusRefreshInterval + time.Minute)
	r3, _, dyn3 := fakeReconcilerSetup(t, later, nil, ctrs2, cpps2, cfbs2)
	if err := r3.reconcileOnce(ctx); err != nil {
		t.Fatalf("third reconcileOnce: %v", err)
	}
	if got := countStatusPatches(dyn3); got != 2 {
		t.Fatalf("refresh pass: %d status patches, want 2 (office CTR + CFB)", got)
	}
	office, err := dyn3.Resource(ctrGVR).Get(ctx, "office", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get office: %v", err)
	}
	if v, _, _ := unstructured.NestedString(office.Object, "status", "lastSyncedAt"); v != rfc(later) {
		t.Errorf("lastSyncedAt = %q, want refreshed %q", v, rfc(later))
	}
	conds, _, _ := unstructured.NestedSlice(office.Object, "status", "conditions")
	if len(conds) != 1 {
		t.Fatalf("conditions = %v", conds)
	}
	if ts := conds[0].(map[string]any)["lastTransitionTime"]; ts != rfc(noopNow) {
		t.Errorf("condition lastTransitionTime = %v, want stable %s (unchanged condition)", ts, rfc(noopNow))
	}
}

// TestReconcileOnce_claimedCPPStatusLeftAlone: once markCPPClaimed has
// written a CPP's status, later passes during the grace window must not
// overwrite its Claimed condition (the backend surfaces it) with
// Ready/Pending — nor write at all.
func TestReconcileOnce_claimedCPPStatusLeftAlone(t *testing.T) {
	ctx := context.Background()
	nodes := []*corev1.Node{node("worker-1", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.5"})}
	cpp := mkCPP("worker-1", "10.0.0.5", "worker", 1800, 60, noopNow, 1)

	r, fa, dyn := fakeReconcilerSetup(t, noopNow, nodes, nil, []*unstructured.Unstructured{cpp}, nil)
	if err := r.reconcileOnce(ctx); err != nil {
		t.Fatalf("claim pass: %v", err)
	}
	claimed, err := dyn.Resource(cppGVR).Get(ctx, "worker-1", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}

	r2, fa2, dyn2 := fakeReconcilerSetup(t, noopNow.Add(time.Minute), nodes, nil, []*unstructured.Unstructured{claimed}, nil)
	if err := r2.reconcileOnce(ctx); err != nil {
		t.Fatalf("grace pass: %v", err)
	}
	if got := countStatusPatches(dyn2); got != 0 {
		t.Errorf("grace pass wrote %d status patches to a claimed CPP, want 0", got)
	}
	after, _ := dyn2.Resource(cppGVR).Get(ctx, "worker-1", metav1.GetOptions{})
	conds, _, _ := unstructured.NestedSlice(after.Object, "status", "conditions")
	if len(conds) != 1 || conds[0].(map[string]any)["type"] != "Claimed" {
		t.Errorf("conditions = %v, want the Claimed condition kept", conds)
	}
	// The claimed peer stays in the peer set throughout the grace window.
	for _, calls := range [][]peerNftSets{fa.calls, fa2.calls} {
		if len(calls) != 1 || !equalSorted(calls[0].PeersV4, []string{"10.0.0.5"}) {
			t.Errorf("peer set = %v, want the claimed peer present", calls)
		}
	}
}
