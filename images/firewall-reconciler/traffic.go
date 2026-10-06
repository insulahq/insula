// Node traffic accounting loop.
//
// Fourth goroutine of the reconciler, deliberately isolated from the three
// firewall loops: it owns only the count-only `inet insula_traffic` table
// (traffic_nft.go) and the `node-traffic-<NODE_NAME>` ConfigMap
// (traffic_publish.go). Its failures are logged at warn with backoff and
// never touch the firewall loops or /healthz.
//
// Each pass computes the desired set content from the informer caches the
// other loops already hold (no extra apiserver load):
//
//	peers_v{4,6} ← InternalIP + ExternalIP of every Node except NODE_NAME
//	shim_v{4,6}  ← IPs of backup-rclone-shim Pods on this node
//	phys_ifs     ← this host's non-virtual interfaces (net.Interfaces)
//
// and every trafficPublishInterval it reads the counters and publishes
// the snapshot.

package main

import (
	"context"
	"log/slog"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
)

const (
	trafficPublishInterval = 30 * time.Second
	trafficBackoffBase     = 30 * time.Second
	trafficBackoffMax      = 5 * time.Minute
	// trafficPublishSlack keeps a publish due on the ticker's next fire even
	// when the tick lands a hair before nextPublish.
	trafficPublishSlack = 2 * time.Second

	backupShimNamespace  = "platform"
	backupShimLabelKey   = "app"
	backupShimLabelValue = "backup-rclone-shim"
)

// virtualIfaceRe — interfaces that are NOT physical: CNI / overlay /
// container plumbing. Same definition the node metrics scrape uses.
var virtualIfaceRe = regexp.MustCompile(`^(cali|tunl|veth|vxlan|wireguard|docker|br-|flannel|cni|dummy|nodelocaldns|kube-ipvs|lo$)`)

// podLister is the slice of corelisters.PodLister the traffic loop uses.
type podLister interface {
	List(selector labels.Selector) ([]*corev1.Pod, error)
}

// trafficSnapshotWriter publishes one snapshot. Injectable for tests.
type trafficSnapshotWriter interface {
	publish(ctx context.Context, snap trafficSnapshot) error
}

// retryBackoff is a tiny exponential backoff: ready() gates attempts,
// fail() pushes the next attempt out (base · 2^(n-1), capped), succeed()
// schedules the next regular attempt.
type retryBackoff struct {
	failures int
	next     time.Time
}

func (b *retryBackoff) ready(now time.Time) bool { return !now.Before(b.next) }

func (b *retryBackoff) fail(now time.Time) time.Duration {
	b.failures++
	d := trafficBackoffBase
	for i := 1; i < b.failures && d < trafficBackoffMax; i++ {
		d *= 2
	}
	if d > trafficBackoffMax {
		d = trafficBackoffMax
	}
	b.next = now.Add(d)
	return d
}

func (b *retryBackoff) succeed(next time.Time) {
	b.failures = 0
	b.next = next
}

type trafficAccountant struct {
	nodeName   string
	nodes      nodeLister
	pods       podLister
	nft        trafficNft
	pub        trafficSnapshotWriter
	interfaces func() ([]net.Interface, error)
	now        func() time.Time
	trigger    chan struct{}

	syncBackoff    retryBackoff
	publishBackoff retryBackoff
}

func newTrafficAccountant(nodeName string, nodes nodeLister, pods podLister, nft trafficNft, pub trafficSnapshotWriter) *trafficAccountant {
	return &trafficAccountant{
		nodeName:   nodeName,
		nodes:      nodes,
		pods:       pods,
		nft:        nft,
		pub:        pub,
		interfaces: net.Interfaces,
		now:        time.Now,
		trigger:    make(chan struct{}, 1),
	}
}

func (a *trafficAccountant) kick() {
	select {
	case a.trigger <- struct{}{}:
	default:
	}
}

// run syncs the nft table on every kick and every tick, and publishes when
// due. Never returns an error — failures are logged and retried.
func (a *trafficAccountant) run(ctx context.Context) {
	a.kick()
	t := time.NewTicker(trafficPublishInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.trigger:
		case <-t.C:
		}
		a.pass(ctx)
	}
}

// pass is one sync (+ publish when due). Split from run for tests.
func (a *trafficAccountant) pass(ctx context.Context) {
	a.sync()
	a.maybePublish(ctx)
}

// sync writes the desired sets (recreating the table when needed).
func (a *trafficAccountant) sync() {
	now := a.now()
	if !a.syncBackoff.ready(now) {
		return
	}
	d, err := a.desired()
	if err == nil {
		var recreated bool
		recreated, err = a.nft.ensure(d)
		if err == nil {
			if recreated {
				slog.Info("traffic accounting table (re)created — counters start from zero",
					"table", trafficTableName,
					"peers_v4", len(d.PeersV4), "peers_v6", len(d.PeersV6),
					"shim_v4", len(d.ShimV4), "shim_v6", len(d.ShimV6),
					"phys_ifs", d.PhysIfs)
			}
			a.syncBackoff.succeed(time.Time{})
			return
		}
	}
	retry := a.syncBackoff.fail(now)
	slog.Warn("traffic accounting sync failed — firewall unaffected, retrying",
		"err", err, "retry_in", retry.String(), "consecutive_failures", a.syncBackoff.failures)
}

// maybePublish reads the counters and writes the ConfigMap when due.
func (a *trafficAccountant) maybePublish(ctx context.Context) {
	now := a.now()
	if !a.publishBackoff.ready(now) {
		return
	}
	reading, err := a.nft.readCounters()
	if err == nil {
		err = a.pub.publish(ctx, buildTrafficSnapshot(a.nodeName, now, reading))
	}
	if err != nil {
		retry := a.publishBackoff.fail(now)
		slog.Warn("traffic snapshot publish failed — firewall unaffected, retrying",
			"err", err, "retry_in", retry.String(), "consecutive_failures", a.publishBackoff.failures)
		return
	}
	a.publishBackoff.succeed(now.Add(trafficPublishInterval - trafficPublishSlack))
}

// desired computes the set content from the informer caches + the host's
// interfaces. An error leaves the kernel sets as they are (never flushed to
// empty on a transient read failure).
func (a *trafficAccountant) desired() (trafficDesired, error) {
	nodes, err := a.nodes.List(labels.Everything())
	if err != nil {
		return trafficDesired{}, err
	}
	pods, err := a.pods.List(labels.Everything())
	if err != nil {
		return trafficDesired{}, err
	}
	ifaces, err := a.interfaces()
	if err != nil {
		return trafficDesired{}, err
	}
	pv4, pv6 := peerNodeIPs(nodes, a.nodeName)
	sv4, sv6 := backupShimIPs(pods, a.nodeName)
	return trafficDesired{
		PeersV4: pv4, PeersV6: pv6,
		ShimV4: sv4, ShimV6: sv6,
		PhysIfs: physicalInterfaces(ifaces),
	}, nil
}

// peerNodeIPs returns every InternalIP and ExternalIP of every Node other
// than self, split by family, deduped and sorted.
func peerNodeIPs(nodes []*corev1.Node, self string) (v4, v6 []string) {
	for _, n := range nodes {
		if n.Name == self {
			continue
		}
		for _, addr := range n.Status.Addresses {
			if addr.Type != corev1.NodeInternalIP && addr.Type != corev1.NodeExternalIP {
				continue
			}
			v4, v6 = appendIP(v4, v6, addr.Address)
		}
	}
	return uniqueSorted(v4), uniqueSorted(v6)
}

// backupShimIPs returns the pod IPs of backup-rclone-shim Pods scheduled to
// this node. hostNetwork Pods are skipped (their IP is the node's own, which
// must never be counted as backup traffic), as are finished Pods.
func backupShimIPs(pods []*corev1.Pod, self string) (v4, v6 []string) {
	for _, p := range pods {
		if !isBackupShimPod(p) || p.Spec.NodeName != self || p.Spec.HostNetwork {
			continue
		}
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		for _, ip := range p.Status.PodIPs {
			v4, v6 = appendIP(v4, v6, ip.IP)
		}
		v4, v6 = appendIP(v4, v6, p.Status.PodIP)
	}
	return uniqueSorted(v4), uniqueSorted(v6)
}

func appendIP(v4, v6 []string, raw string) ([]string, []string) {
	a, err := netip.ParseAddr(raw)
	if err != nil {
		return v4, v6
	}
	a = a.Unmap()
	if a.Is4() {
		return append(v4, a.String()), v6
	}
	return v4, append(v6, a.String())
}

// physicalInterfaces filters out loopback and virtual interfaces.
func physicalInterfaces(ifaces []net.Interface) []string {
	out := []string{}
	for _, i := range ifaces {
		if i.Flags&net.FlagLoopback != 0 || virtualIfaceRe.MatchString(i.Name) {
			continue
		}
		out = append(out, i.Name)
	}
	sort.Strings(out)
	return out
}
