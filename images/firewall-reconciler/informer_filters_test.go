package main

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/cache"
)

func TestCRDUpdateNeedsReconcile(t *testing.T) {
	base := func() *unstructured.Unstructured {
		u := mkCTR("office", "198.51.100.0/24", 3)
		u.SetLabels(map[string]string{"a": "1"})
		u.SetAnnotations(map[string]string{"note": "x"})
		u.SetResourceVersion("100")
		return u
	}
	cases := []struct {
		name   string
		mutate func(u *unstructured.Unstructured)
		want   bool
	}{
		{"resync (identical object) → no kick", func(*unstructured.Unstructured) {}, false},
		{"status-only write → no kick", func(u *unstructured.Unstructured) {
			u.SetResourceVersion("101")
			_ = unstructured.SetNestedField(u.Object, "2026-10-06T12:00:00Z", "status", "lastSyncedAt")
			_ = unstructured.SetNestedField(u.Object, int64(3), "status", "observedGeneration")
		}, false},
		{"spec change (generation bump) → kick", func(u *unstructured.Unstructured) {
			u.SetGeneration(4)
			_ = unstructured.SetNestedField(u.Object, "203.0.113.0/24", "spec", "cidr")
		}, true},
		{"label change → kick", func(u *unstructured.Unstructured) { u.SetLabels(map[string]string{"a": "2"}) }, true},
		{"annotation added → kick", func(u *unstructured.Unstructured) {
			u.SetAnnotations(map[string]string{"note": "x", "more": "y"})
		}, true},
		{"deletionTimestamp set → kick", func(u *unstructured.Unstructured) {
			ts := metav1.NewTime(time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC))
			u.SetDeletionTimestamp(&ts)
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			oldObj, newObj := base(), base()
			tc.mutate(newObj)
			if got := crdUpdateNeedsReconcile(oldObj, newObj); got != tc.want {
				t.Errorf("crdUpdateNeedsReconcile = %v, want %v", got, tc.want)
			}
		})
	}
	if !crdUpdateNeedsReconcile("not-an-object", base()) {
		t.Error("unreadable object must fail open (kick)")
	}
}

func TestNodeUpdateNeedsReconcile(t *testing.T) {
	base := func() *corev1.Node {
		return &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{
				Name: "n1", ResourceVersion: "5",
				Labels:      map[string]string{"node-role.kubernetes.io/control-plane": "true"},
				Annotations: map[string]string{"k3s.io/node-args": "[]"},
			},
			Spec: corev1.NodeSpec{PodCIDR: "10.42.0.0/24"},
			Status: corev1.NodeStatus{
				Addresses: []corev1.NodeAddress{
					{Type: corev1.NodeInternalIP, Address: "10.0.0.1"},
					{Type: corev1.NodeExternalIP, Address: "203.0.113.10"},
				},
				Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
			},
		}
	}
	cases := []struct {
		name   string
		mutate func(n *corev1.Node)
		want   bool
	}{
		{"resync → no kick", func(*corev1.Node) {}, false},
		{"heartbeat (conditions + images + resourceVersion) → no kick", func(n *corev1.Node) {
			n.ResourceVersion = "6"
			n.Status.Conditions[0].LastHeartbeatTime = metav1.NewTime(time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC))
			n.Status.Images = []corev1.ContainerImage{{Names: []string{"img"}}}
		}, false},
		{"address changed → kick", func(n *corev1.Node) { n.Status.Addresses[1].Address = "203.0.113.11" }, true},
		{"address added → kick", func(n *corev1.Node) {
			n.Status.Addresses = append(n.Status.Addresses, corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "fd00::1"})
		}, true},
		{"taint added → kick", func(n *corev1.Node) {
			n.Spec.Taints = []corev1.Taint{{Key: "k", Effect: corev1.TaintEffectNoSchedule}}
		}, true},
		{"spec.unschedulable → kick", func(n *corev1.Node) { n.Spec.Unschedulable = true }, true},
		{"label change → kick", func(n *corev1.Node) { n.Labels = map[string]string{} }, true},
		{"annotation change → kick", func(n *corev1.Node) { n.Annotations["k3s.io/node-args"] = "[x]" }, true},
		{"deletionTimestamp → kick", func(n *corev1.Node) {
			ts := metav1.NewTime(time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC))
			n.DeletionTimestamp = &ts
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			oldObj, newObj := base(), base()
			tc.mutate(newObj)
			if got := nodeUpdateNeedsReconcile(oldObj, newObj); got != tc.want {
				t.Errorf("nodeUpdateNeedsReconcile = %v, want %v", got, tc.want)
			}
		})
	}
	if !nodeUpdateNeedsReconcile(base(), "not-a-node") {
		t.Error("non-Node object must fail open (kick)")
	}
}

func TestIsBackupShimPod(t *testing.T) {
	shim := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "s", Namespace: backupShimNamespace, Labels: map[string]string{"app": "backup-rclone-shim"},
	}}
	if !isBackupShimPod(shim) {
		t.Error("shim pod not recognised")
	}
	if !isBackupShimPod(cache.DeletedFinalStateUnknown{Key: "platform/s", Obj: shim}) {
		t.Error("shim pod inside a delete tombstone not recognised")
	}
	other := shim.DeepCopy()
	other.Namespace = "tenant-x"
	if isBackupShimPod(other) {
		t.Error("same label in another namespace must not count")
	}
	other = shim.DeepCopy()
	other.Labels = map[string]string{"app": "platform-api"}
	if isBackupShimPod(other) {
		t.Error("other app label must not count")
	}
	if isBackupShimPod("nope") {
		t.Error("non-pod must not count")
	}
}
