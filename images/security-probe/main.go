// security-probe — read-only host posture probe.
//
// One pod per node (DaemonSet). Every PROBE_INTERVAL_SECONDS the
// probe:
//
//  1. parses /host/etc/ssh/sshd_config (incl. drop-in dir + Include)
//  2. enumerates /host/sys/class/net for mesh interfaces (wt0,
//     tailscale0, wg0) and reads peer counts via WireGuard proc
//     (when present),
//  3. samples /host/proc/net/nf_conntrack for recent denied flows,
//  4. reads /host/etc/os-release, /host/proc/sys/kernel/osrelease,
//     /host/proc/stat boot time, and presence of fail2ban /
//     sshguard / unattended-upgrades binaries on the host,
//  5. WRITES one ConfigMap (security-probe-<node>) in
//     platform-system with the JSON snapshot at data.snapshot,
//  6. and, continuously, witnesses pod memory-cgroup OOM counters
//     (/host/sys/fs/cgroup, memcg.go), published at data.memcg.
//
// Security posture (see daemonset.yaml for the corresponding
// SecurityContext): readOnlyRootFilesystem, capabilities drop ALL,
// no privileged, no hostNetwork, no hostPID. Every hostPath mount is
// readOnly. The only mutation the probe performs is to its own
// ConfigMap via the apiserver (RBAC-scoped).
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"syscall"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const (
	// Default loop interval — overridable via PROBE_INTERVAL_SECONDS.
	defaultInterval = 60 * time.Second
	// Minimum loop interval — protects against operator misconfig.
	minInterval = 10 * time.Second
	// Maximum loop interval — protects against silent staleness.
	maxInterval = 600 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	nodeName := os.Getenv("NODE_NAME")
	if nodeName == "" {
		slog.Error("NODE_NAME env required (downward API spec.nodeName)")
		os.Exit(1)
	}
	namespace := os.Getenv("POD_NAMESPACE")
	if namespace == "" {
		namespace = "platform-system"
	}
	interval := parseInterval(os.Getenv("PROBE_INTERVAL_SECONDS"))

	cfg, err := rest.InClusterConfig()
	if err != nil {
		slog.Error("rest.InClusterConfig", "err", err)
		os.Exit(1)
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		slog.Error("kubernetes.NewForConfig", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
		defer signal.Stop(sigs)
		<-sigs
		slog.Info("shutdown signal received")
		cancel()
	}()

	hs := &healthState{}
	startHealthServer(ctx, hs)

	pub := newConfigMapPublisher(clientset, namespace, nodeName)
	collector := newCollector("/host")
	witness := newMemcgWitness("/host")
	go witness.run(ctx)

	slog.Info("security-probe starting",
		"node", nodeName, "namespace", namespace, "intervalSeconds", interval.Seconds())

	// Kick once at start so the page has data before the first tick.
	last := runOnce(ctx, collector, pub, witness, hs, nil)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("security-probe exiting")
			return
		case <-t.C:
			last = runOnce(ctx, collector, pub, witness, hs, nil)
		case <-witness.changed:
			// An OOM just happened. Publish the witness now rather than up to a
			// minute later — the backend will not judge a kill until a snapshot
			// newer than it is published. A short settle window lets a burst
			// (every container of a pod, every ancestor cgroup) land as one.
			select {
			case <-ctx.Done():
				return
			case <-time.After(memcgPublishSettle):
			}
			drainSignal(witness.changed)
			last = runOnce(ctx, collector, pub, witness, hs, last)
		}
	}
}

// runOnce wraps one collect+publish cycle in recover() so a panic in
// (say) sshd_config parsing doesn't kill the pod. With `reuse` set it skips
// the host-posture collection and republishes that snapshot with a fresh
// OOM witness. Returns the posture snapshot it published.
func runOnce(
	ctx context.Context, c *collector, pub *configMapPublisher, witness *memcgWitness, hs *healthState, reuse *Snapshot,
) (published *Snapshot) {
	published = reuse
	defer func() {
		if r := recover(); r != nil {
			slog.Error("probe loop panic",
				"recover", r,
				"stack", string(debug.Stack()))
		}
	}()
	snap := Snapshot{}
	if reuse != nil {
		snap = *reuse
	} else {
		var err error
		snap, err = c.collect()
		if err != nil {
			slog.Warn("collect partial", "err", err)
		}
	}
	if err := pub.publish(ctx, snap, witness.snapshot()); err != nil {
		slog.Error("publish", "err", err)
		return published
	}
	hs.markHealthy(time.Now())
	return &snap
}

func drainSignal(ch <-chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// parseInterval honors PROBE_INTERVAL_SECONDS within [min,max], falls
// back to defaultInterval on missing/invalid input.
func parseInterval(raw string) time.Duration {
	if raw == "" {
		return defaultInterval
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		slog.Warn("PROBE_INTERVAL_SECONDS invalid — using default",
			"raw", raw, "default", defaultInterval.Seconds())
		return defaultInterval
	}
	d := time.Duration(n) * time.Second
	if d < minInterval {
		return minInterval
	}
	if d > maxInterval {
		return maxInterval
	}
	return d
}
