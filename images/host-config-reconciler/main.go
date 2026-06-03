// host-config-reconciler — host-config drift detector + (opt-in) converger
// (W10 / ADR-045). One binary, two roles selected by HOSTCONFIG_ROLE:
//
//   detect (default) — the OBSERVE-only drift detector. Every interval it reads
//     host-config-desired + the READ-ONLY /host/proc/sys mount, classifies each
//     desired key ok|drift|unreadable|not-allowed, and writes one
//     host-config-drift-<node> ConfigMap. It NEVER writes host state. Security
//     posture (k8s/base/host-config-reconciler/daemonset.yaml): drop ALL caps,
//     no privileged, no host namespaces, read-only mounts. Mirrors security-probe.
//
//   converge — the PRIVILEGED enforcer, shipped as an OPT-IN component
//     (k8s/components/host-config-enforcer/) that is NOT in the default base. It
//     writes the drifting, allow-listed sysctls to a RW /proc/sys mount ONLY when
//     host-config-desired.data.mode == "enforce" (else it dry-runs), and records
//     the outcome in host-config-applied-<node>. The write path re-checks the
//     allow-list + /proc/sys containment (enforcer.go) — fail-closed.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const (
	defaultInterval = 60 * time.Second
	minInterval     = 10 * time.Second
	maxInterval     = 600 * time.Second
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
	interval := parseInterval(os.Getenv("HOSTCONFIG_INTERVAL_SECONDS"))

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
	// hostNetwork CONVERGE pods bind the host's loopback, so the enforcer uses a
	// distinct port (HEALTH_PORT=8084) from the observe detector's :8083.
	healthAddr := ":8083"
	if p := strings.TrimSpace(os.Getenv("HEALTH_PORT")); p != "" {
		healthAddr = ":" + p
	}
	startHealthServer(ctx, hs, healthAddr)

	pub := newConfigMapPublisher(clientset, namespace, nodeName)

	// HOSTCONFIG_ROLE selects the binary's behaviour:
	//   "detect" (default) — the locked-down OBSERVE-only drift detector.
	//   "converge"         — the PRIVILEGED enforcer (opt-in DaemonSet) that
	//                        writes drifting sysctls when the desired policy's
	//                        data.mode == "enforce" (else it dry-runs).
	role := strings.ToLower(strings.TrimSpace(os.Getenv("HOSTCONFIG_ROLE")))

	var tick func()
	if role == "converge" {
		io := newRealSysctlIO("/host")
		slog.Info("host-config-reconciler starting (CONVERGE mode — privileged enforcer)",
			"node", nodeName, "namespace", namespace, "intervalSeconds", interval.Seconds())
		tick = func() { convergeOnce(ctx, clientset, namespace, nodeName, io, pub, hs) }
	} else {
		collector := newCollector("/host", nodeName)
		slog.Info("host-config-reconciler starting (observe mode)",
			"node", nodeName, "namespace", namespace, "intervalSeconds", interval.Seconds())
		tick = func() { runOnce(ctx, clientset, namespace, collector, pub, hs) }
	}

	tick()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("host-config-reconciler exiting")
			return
		case <-t.C:
			tick()
		}
	}
}

// convergeOnce wraps one load+converge+publish cycle in recover() so a panic in
// parsing/reading/writing never kills the pod. It writes host state ONLY when
// the desired policy's data.mode == "enforce" (else dry-run).
func convergeOnce(ctx context.Context, client kubernetes.Interface, namespace, nodeName string, io sysctlIO, pub *configMapPublisher, hs *healthState) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("converge loop panic", "recover", r, "stack", string(debug.Stack()))
		}
	}()
	desired, err := loadDesired(ctx, client, namespace)
	if err != nil {
		slog.Warn("loadDesired", "err", err)
	}
	enforcing := desired != nil && strings.EqualFold(desired.Mode, "enforce")
	snap := converge(desired, enforcing, io, sysctlAllowed, time.Now, nodeName)
	if err != nil {
		snap.Errors = append(snap.Errors, "loadDesired: "+err.Error())
	}
	if perr := pub.publishApplied(ctx, snap); perr != nil {
		slog.Error("publishApplied", "err", perr)
		return
	}
	slog.Info("converge cycle", "mode", snap.Mode, "appliedCount", snap.AppliedCount, "items", len(snap.Items))
	hs.markHealthy(time.Now())
}

// runOnce wraps one load+collect+publish cycle in recover() so a panic in
// parsing/reading never kills the pod.
func runOnce(ctx context.Context, client kubernetes.Interface, namespace string, c *collector, pub *configMapPublisher, hs *healthState) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("reconcile loop panic", "recover", r, "stack", string(debug.Stack()))
		}
	}()
	desired, err := loadDesired(ctx, client, namespace)
	if err != nil {
		// A desired-read failure is not fatal — publish an observe snapshot
		// carrying the error so the drift surface shows the loop ran but
		// couldn't read policy, rather than going silently stale.
		slog.Warn("loadDesired", "err", err)
	}
	snap := c.collect(desired)
	if err != nil {
		snap.Errors = append(snap.Errors, "loadDesired: "+err.Error())
	}
	if perr := pub.publish(ctx, snap); perr != nil {
		slog.Error("publish", "err", perr)
		return
	}
	hs.markHealthy(time.Now())
}

// parseInterval honors HOSTCONFIG_INTERVAL_SECONDS within [min,max], falling
// back to defaultInterval on missing/invalid input.
func parseInterval(raw string) time.Duration {
	if raw == "" {
		return defaultInterval
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		slog.Warn("HOSTCONFIG_INTERVAL_SECONDS invalid — using default", "raw", raw, "default", defaultInterval.Seconds())
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
