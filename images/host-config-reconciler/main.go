// host-config-reconciler — OBSERVE-ONLY host-config drift detector (W10 / ADR-045).
//
// One pod per node (DaemonSet). Every HOSTCONFIG_INTERVAL_SECONDS it:
//   1. reads the operator-managed host-config-desired ConfigMap (sysctls),
//   2. reads the live values from the READ-ONLY /host/proc/sys mount,
//   3. classifies each desired key ok | drift | unreadable | not-allowed,
//   4. WRITES one ConfigMap (host-config-drift-<node>) in platform-system with
//      the JSON snapshot at data.snapshot.
//
// OBSERVE MODE: the reconciler NEVER writes host state — it only reports
// desired-vs-actual. Write/enforce (converge) mode is a deliberate later PR.
//
// Security posture (see daemonset.yaml SecurityContext): readOnlyRootFilesystem,
// capabilities drop ALL, no privileged, no hostNetwork, no hostPID, no hostIPC.
// Every hostPath mount is readOnly. The only mutation is to its own ConfigMap
// via the RBAC-scoped apiserver. Mirrors the security-probe DaemonSet.
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
	startHealthServer(ctx, hs)

	pub := newConfigMapPublisher(clientset, namespace, nodeName)
	collector := newCollector("/host", nodeName)

	slog.Info("host-config-reconciler starting (observe mode)",
		"node", nodeName, "namespace", namespace, "intervalSeconds", interval.Seconds())

	runOnce(ctx, clientset, namespace, collector, pub, hs)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("host-config-reconciler exiting")
			return
		case <-t.C:
			runOnce(ctx, clientset, namespace, collector, pub, hs)
		}
	}
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
