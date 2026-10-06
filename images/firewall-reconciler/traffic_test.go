package main

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

func TestPeerNodeIPs(t *testing.T) {
	nodes := []*corev1.Node{
		node("self",
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.1"},
			corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: "203.0.113.1"}),
		node("peer-a",
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.2"},
			corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: "203.0.113.2"},
			corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: "2001:db8::2"},
			corev1.NodeAddress{Type: corev1.NodeHostName, Address: "peer-a"}),
		node("peer-b",
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "203.0.113.2"}, // duplicate → deduped
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "not-an-ip"}),
	}
	v4, v6 := peerNodeIPs(nodes, "self")
	if want := []string{"10.0.0.2", "203.0.113.2"}; !reflect.DeepEqual(v4, want) {
		t.Errorf("v4 = %v, want %v (self excluded, External included, deduped)", v4, want)
	}
	if want := []string{"2001:db8::2"}; !reflect.DeepEqual(v6, want) {
		t.Errorf("v6 = %v, want %v", v6, want)
	}
}

func shimPod(name, nodeName string, ips ...string) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "platform", Labels: map[string]string{"app": "backup-rclone-shim"}},
		Spec:       corev1.PodSpec{NodeName: nodeName},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
	for _, ip := range ips {
		p.Status.PodIPs = append(p.Status.PodIPs, corev1.PodIP{IP: ip})
	}
	if len(ips) > 0 {
		p.Status.PodIP = ips[0]
	}
	return p
}

func TestBackupShimIPs(t *testing.T) {
	hostNet := shimPod("hostnet", "self", "10.0.0.1")
	hostNet.Spec.HostNetwork = true
	done := shimPod("done", "self", "10.42.0.99")
	done.Status.Phase = corev1.PodSucceeded
	wrongNS := shimPod("other-ns", "self", "10.42.0.50")
	wrongNS.Namespace = "tenant-a"
	otherApp := shimPod("other-app", "self", "10.42.0.51")
	otherApp.Labels = map[string]string{"app": "platform-api"}

	pods := []*corev1.Pod{
		shimPod("shim", "self", "10.42.0.7", "fd42::7"),
		shimPod("elsewhere", "peer-a", "10.42.1.7"),
		hostNet, done, wrongNS, otherApp,
	}
	v4, v6 := backupShimIPs(pods, "self")
	if want := []string{"10.42.0.7"}; !reflect.DeepEqual(v4, want) {
		t.Errorf("v4 = %v, want %v", v4, want)
	}
	if want := []string{"fd42::7"}; !reflect.DeepEqual(v6, want) {
		t.Errorf("v6 = %v, want %v", v6, want)
	}
}

func TestPhysicalInterfaces(t *testing.T) {
	mk := func(name string, flags net.Flags) net.Interface { return net.Interface{Name: name, Flags: flags} }
	in := []net.Interface{
		mk("lo", net.FlagLoopback|net.FlagUp),
		mk("eth0", net.FlagUp), mk("ens3", net.FlagUp), mk("enp1s0", 0), mk("bond0", net.FlagUp),
		mk("br0", net.FlagUp), mk("wt0", net.FlagUp), mk("lo0", net.FlagUp),
		mk("cali1a2b3c", 0), mk("tunl0", 0), mk("veth1234", 0), mk("vxlan.calico", 0),
		mk("wireguard.cali", 0), mk("docker0", 0), mk("br-0a1b2c", 0), mk("flannel.1", 0),
		mk("cni0", 0), mk("dummy0", 0), mk("nodelocaldns", 0), mk("kube-ipvs0", 0),
		mk("weird-loop", net.FlagLoopback),
	}
	want := []string{"bond0", "br0", "enp1s0", "ens3", "eth0", "lo0", "wt0"}
	if got := physicalInterfaces(in); !reflect.DeepEqual(got, want) {
		t.Errorf("physicalInterfaces = %v, want %v", got, want)
	}
}

func TestRetryBackoff(t *testing.T) {
	var b retryBackoff
	now := noopNow
	if !b.ready(now) {
		t.Fatal("zero backoff must be ready")
	}
	var got []time.Duration
	for i := 0; i < 7; i++ {
		got = append(got, b.fail(now))
	}
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("backoff = %v, want %v", got, want)
	}
	if b.ready(now.Add(4 * time.Minute)) {
		t.Error("must not be ready inside the backoff window")
	}
	b.succeed(now)
	if !b.ready(now) || b.failures != 0 {
		t.Error("succeed must reset")
	}
}

// fakeTrafficNft records ensure calls and serves a fixed reading.
type fakeTrafficNft struct {
	ensured   []trafficDesired
	ensureErr error
	reads     int
	reading   trafficReading
	readErr   error
}

func (f *fakeTrafficNft) ensure(d trafficDesired) (bool, error) {
	f.ensured = append(f.ensured, d)
	return len(f.ensured) == 1, f.ensureErr
}

func (f *fakeTrafficNft) readCounters() (trafficReading, error) {
	f.reads++
	return f.reading, f.readErr
}

type fakeSnapshotWriter struct {
	snaps []trafficSnapshot
	err   error
}

func (f *fakeSnapshotWriter) publish(_ context.Context, s trafficSnapshot) error {
	f.snaps = append(f.snaps, s)
	return f.err
}

type staticPods []*corev1.Pod

func (s staticPods) List(labels.Selector) ([]*corev1.Pod, error) { return s, nil }

func newTestAccountant(clock *time.Time) (*trafficAccountant, *fakeTrafficNft, *fakeSnapshotWriter) {
	nodes := staticLister{items: []*corev1.Node{
		node("self", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.1"}),
		node("peer", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.2"}),
	}}
	nft := &fakeTrafficNft{reading: trafficReading{Epoch: "0123456789abcdef", Counters: map[string]counterValue{"kubeapi_in": {Bytes: 7, Packets: 3}}}}
	pub := &fakeSnapshotWriter{}
	a := newTrafficAccountant("self", nodes, staticPods{shimPod("shim", "self", "10.42.0.7")}, nft, pub)
	a.interfaces = func() ([]net.Interface, error) {
		return []net.Interface{{Name: "lo", Flags: net.FlagLoopback}, {Name: "eth0"}, {Name: "cali1"}}, nil
	}
	a.now = func() time.Time { return *clock }
	return a, nft, pub
}

func TestTrafficAccountant_passSyncsAndPublishes(t *testing.T) {
	clock := noopNow
	a, nft, pub := newTestAccountant(&clock)
	ctx := context.Background()

	a.pass(ctx)
	if len(nft.ensured) != 1 {
		t.Fatalf("ensure calls = %d, want 1", len(nft.ensured))
	}
	want := trafficDesired{PeersV4: []string{"10.0.0.2"}, ShimV4: []string{"10.42.0.7"}, PhysIfs: []string{"eth0"}}
	got := nft.ensured[0]
	if !reflect.DeepEqual(got.PeersV4, want.PeersV4) || !reflect.DeepEqual(got.ShimV4, want.ShimV4) ||
		!reflect.DeepEqual(got.PhysIfs, want.PhysIfs) || len(got.PeersV6) != 0 || len(got.ShimV6) != 0 {
		t.Errorf("desired = %+v, want %+v", got, want)
	}
	if len(pub.snaps) != 1 || pub.snaps[0].Counters.KubeAPI.In != 7 || pub.snaps[0].Counters.KubeAPI.InPackets != 3 || pub.snaps[0].Node != "self" {
		t.Fatalf("published = %+v", pub.snaps)
	}

	// A kick 5 s later re-syncs the sets but does not publish again.
	clock = noopNow.Add(5 * time.Second)
	a.pass(ctx)
	if len(nft.ensured) != 2 || len(pub.snaps) != 1 {
		t.Errorf("after kick: ensure=%d publish=%d, want 2/1", len(nft.ensured), len(pub.snaps))
	}
	// The next 30 s tick publishes.
	clock = noopNow.Add(trafficPublishInterval)
	a.pass(ctx)
	if len(pub.snaps) != 2 {
		t.Errorf("after tick: publish=%d, want 2", len(pub.snaps))
	}
}

func TestTrafficAccountant_publishFailureBacksOff(t *testing.T) {
	clock := noopNow
	a, _, pub := newTestAccountant(&clock)
	pub.err = errors.New("apiserver down")
	ctx := context.Background()

	a.pass(ctx) // fails → retry in 30 s
	clock = noopNow.Add(31 * time.Second)
	a.pass(ctx) // fails → retry in 60 s
	clock = noopNow.Add(61 * time.Second)
	a.pass(ctx) // inside the 60 s window → no attempt
	if len(pub.snaps) != 2 {
		t.Fatalf("publish attempts = %d, want 2 (third inside backoff)", len(pub.snaps))
	}
	pub.err = nil
	clock = noopNow.Add(92 * time.Second)
	a.pass(ctx)
	if len(pub.snaps) != 3 || a.publishBackoff.failures != 0 {
		t.Errorf("recovery: attempts=%d failures=%d", len(pub.snaps), a.publishBackoff.failures)
	}
}

func TestTrafficAccountant_nftFailuresAreContained(t *testing.T) {
	clock := noopNow
	a, nft, pub := newTestAccountant(&clock)
	nft.ensureErr = errors.New("netlink: operation not supported")
	nft.readErr = errors.New("no table")
	ctx := context.Background()

	a.pass(ctx)
	if len(pub.snaps) != 0 {
		t.Error("must not publish when the counters cannot be read")
	}
	clock = noopNow.Add(10 * time.Second)
	a.pass(ctx)
	if len(nft.ensured) != 1 {
		t.Errorf("ensure attempts = %d, want 1 (second inside backoff)", len(nft.ensured))
	}
}

func TestTrafficAccountant_desiredErrorKeepsKernelSets(t *testing.T) {
	clock := noopNow
	a, nft, _ := newTestAccountant(&clock)
	a.interfaces = func() ([]net.Interface, error) { return nil, errors.New("netlink dump failed") }
	a.sync()
	if len(nft.ensured) != 0 {
		t.Error("a failed interface read must not write (possibly empty) sets")
	}
}
