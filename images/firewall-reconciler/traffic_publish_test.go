package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestBuildTrafficSnapshot_exactJSON(t *testing.T) {
	r := trafficReading{Epoch: "0123456789abcdef", Counters: map[string]counterValue{
		"kubeapi_in": {1, 101}, "kubeapi_out": {2, 102}, "etcd_in": {3, 103}, "etcd_out": {4, 104},
		"kubelet_in": {5, 105}, "kubelet_out": {6, 106}, "tunnel_in": {7, 107}, "tunnel_out": {8, 108},
		"n2nother_in": {9, 109}, "n2nother_out": {10, 110}, "backup_in": {11, 111}, "backup_out": {1 << 40, 112},
	}}
	b, err := json.Marshal(buildTrafficSnapshot("node-1", noopNow, r))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":1,"node":"node-1","sampledAt":"2026-10-06T12:00:00Z","epoch":"0123456789abcdef",` +
		`"counters":{"kubeapi":{"in":1,"out":2,"inPackets":101,"outPackets":102},` +
		`"etcd":{"in":3,"out":4,"inPackets":103,"outPackets":104},` +
		`"kubelet":{"in":5,"out":6,"inPackets":105,"outPackets":106},` +
		`"tunnel":{"in":7,"out":8,"inPackets":107,"outPackets":108},` +
		`"n2nother":{"in":9,"out":10,"inPackets":109,"outPackets":110},` +
		`"backup":{"in":11,"out":1099511627776,"inPackets":111,"outPackets":112}}}`
	if string(b) != want {
		t.Errorf("snapshot JSON =\n%s\nwant\n%s", b, want)
	}
}

func TestTrafficConfigMapName(t *testing.T) {
	if n, err := trafficConfigMapName("node-1.example.test"); err != nil || n != "node-traffic-node-1.example.test" {
		t.Errorf("name = %q, %v", n, err)
	}
	for _, bad := range []string{"Upper", strings.Repeat("a", 241), "has_underscore"} {
		if _, err := trafficConfigMapName(bad); err == nil {
			t.Errorf("node name %q must be rejected", bad)
		}
	}
}

func verbs(cs *fake.Clientset) []string {
	var out []string
	for _, a := range cs.Actions() {
		out = append(out, a.GetVerb())
	}
	return out
}

func TestTrafficCMPublisher_createThenPatch(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	self := node("node-1")
	self.UID = types.UID("uid-1")
	p := newTrafficPublisher(cs, "node-1", staticLister{items: []*corev1.Node{self}})

	snap := buildTrafficSnapshot("node-1", noopNow, trafficReading{Epoch: "0123456789abcdef", Counters: map[string]counterValue{"etcd_in": {Bytes: 5, Packets: 1}}})
	if err := p.publish(ctx, snap); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	if got := strings.Join(verbs(cs), ","); got != "patch,create" {
		t.Errorf("first publish verbs = %s, want patch,create (no GET)", got)
	}
	cm, err := cs.CoreV1().ConfigMaps("platform-system").Get(ctx, "node-traffic-node-1", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get cm: %v", err)
	}
	if cm.Labels["app.kubernetes.io/name"] != "node-traffic" || cm.Labels["app.kubernetes.io/part-of"] != "hosting-platform" {
		t.Errorf("labels = %v", cm.Labels)
	}
	if len(cm.OwnerReferences) != 1 || cm.OwnerReferences[0].Kind != "Node" || cm.OwnerReferences[0].UID != "uid-1" {
		t.Errorf("ownerReferences = %+v, want the Node", cm.OwnerReferences)
	}
	var got trafficSnapshot
	if err := json.Unmarshal([]byte(cm.Data["snapshot"]), &got); err != nil || got.Counters.Etcd.In != 5 {
		t.Errorf("data.snapshot = %q (%v)", cm.Data["snapshot"], err)
	}

	cs.ClearActions()
	snap.Counters.Etcd.In = 9
	if err := p.publish(ctx, snap); err != nil {
		t.Fatalf("second publish: %v", err)
	}
	if got := strings.Join(verbs(cs), ","); got != "patch" {
		t.Errorf("second publish verbs = %s, want patch only", got)
	}
	cm, _ = cs.CoreV1().ConfigMaps("platform-system").Get(ctx, "node-traffic-node-1", metav1.GetOptions{})
	if !strings.Contains(cm.Data["snapshot"], `"etcd":{"in":9`) {
		t.Errorf("patched snapshot = %s", cm.Data["snapshot"])
	}
	if len(cm.OwnerReferences) != 1 {
		t.Error("patch must not drop the owner reference")
	}
}

func TestTrafficCMPublisher_createRaceFallsBackToPatch(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	patches := 0
	cs.PrependReactor("patch", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		patches++
		if patches == 1 {
			return true, nil, apierrors.NewNotFound(corev1.Resource("configmaps"), "node-traffic-node-1")
		}
		return true, &corev1.ConfigMap{}, nil
	})
	cs.PrependReactor("create", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewAlreadyExists(corev1.Resource("configmaps"), "node-traffic-node-1")
	})
	p := newTrafficPublisher(cs, "node-1", nil)
	if err := p.publish(ctx, trafficSnapshot{Version: 1, Node: "node-1"}); err != nil {
		t.Fatalf("publish after create race: %v", err)
	}
	if patches != 2 {
		t.Errorf("patch attempts = %d, want 2", patches)
	}
}

func TestTrafficCMPublisher_surfacesErrors(t *testing.T) {
	cs := fake.NewClientset()
	cs.PrependReactor("patch", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(corev1.Resource("configmaps"), "x", nil)
	})
	p := newTrafficPublisher(cs, "node-1", nil)
	err := p.publish(context.Background(), trafficSnapshot{})
	if err == nil || !apierrors.IsForbidden(err) {
		t.Errorf("err = %v, want wrapped Forbidden", err)
	}
	if strings.Contains(strings.Join(verbs(cs), ","), "create") {
		t.Error("a non-NotFound patch error must not fall through to create")
	}
}
