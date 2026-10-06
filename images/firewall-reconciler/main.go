// firewall-reconciler — always-on set-mode firewall converger.
//
// Consolidated from peer-firewall-reconciler + worker-firewall-reconciler
// into a single binary running two independent reconcile goroutines
// against the same libnftnl applier:
//
//	peer loop (cluster scope) — three kube-API sources, four nft sets:
//	  Node.status.addresses[InternalIP] → cluster_peers_v{4,6}    (peer)
//	  ClusterPendingPeer.spec.ip        → cluster_peers_v{4,6}    (peer)
//	                                       union with Node IPs;
//	                                       TTL-enforced; claimed on match
//	  ClusterTrustedRange.spec.cidr     → trusted_ranges_v{4,6}   (trust)
//
//	tenant-ports loop (node scope) — Pods scheduled to NODE_NAME:
//	  spec.containers[*].ports[*].hostPort + protocol  → tenant_ports_{tcp,udp}
//	  metadata.annotations["platform.io/firewall-{tcp,udp}-ports"]
//
// cluster_peers gates control-plane ports (6443/8443/10250/5473/2379-2380).
// trusted_ranges gates full TCP/UDP for operator-blessed sources.
// tenant_ports gates per-tenant hostPort exposure (catalog deploy gate).
//
//	traffic loop (node scope, count-only — traffic*.go) — owns its OWN
//	table `inet insula_traffic`, never `inet filter`:
//	  Node Internal+ExternalIPs except NODE_NAME → peers_v{4,6}
//	  backup-rclone-shim Pod IPs on this node    → shim_v{4,6}
//	  non-virtual host interfaces                → phys_ifs
//	  named counters kubeapi/etcd/kubelet/tunnel/n2nother/backup _in/_out,
//	  filled by policy-accept prerouting(-90)/postrouting(90) chains whose
//	  only verdicts are return/jump — they never change a packet's fate.
//	  Every 30 s the byte + packet counters are published to ConfigMap
//	  platform-system/node-traffic-<NODE_NAME> (data.snapshot, JSON) for
//	  platform-api. Failures are warn-logged with backoff and never touch
//	  the firewall loops or /healthz.
//
// Bootstrap.sh declares the inet filter sets on every node; this reconciler
// is the only writer at runtime. No `nft` binary in the container —
// libnftnl talks netlink directly so the kernel's stable wire format
// is the only userspace/kernel ABI in play.
//
// Runs as DaemonSet hostNetwork: true so the kernel netfilter context
// is the host's. Drops to bare CAP_NET_ADMIN — no privileged
// escalation, no host PID/IPC. CAP_NET_ADMIN also covers the traffic
// table and reading its counters.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

const (
	floorReconcile = 30 * time.Second
	informerResync = 10 * time.Minute
	nftTimeout     = 5 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// Pre-flight: confirm the kernel has the inet filter table. The
	// reconciler's applier creates the four sets if they're missing
	// (idempotent), but the table itself must already exist —
	// bootstrap.sh creates it as part of nftables.conf.
	if err := preflightFilterTable(); err != nil {
		slog.Error("nftables preflight failed",
			"err", err,
			"hint", "ensure bootstrap.sh ran and nftables.service is active; the inet filter table must exist before this reconciler runs")
		idleForever()
		return
	}

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
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		slog.Error("dynamic.NewForConfig", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
		// signal.Stop unregisters the channel so a future cancel path
		// (e.g. test harness, restart-on-cache-failure) doesn't leak the
		// signal subscription. signal.Notify registrations are global —
		// no Stop here means the channel stays subscribed for the
		// process lifetime, which mostly doesn't matter for a DaemonSet
		// but trips signal-hygiene linters.
		defer signal.Stop(sigs)
		<-sigs
		slog.Info("shutdown signal received")
		cancel()
	}()

	// Typed Node informer (peer loop) + Namespace informer (tenant loop
	// classifier). The shared factory caches both so we pay one informer
	// connection per resource type even when the loops run in
	// parallel.
	coreFactory := informers.NewSharedInformerFactory(clientset, informerResync)
	nodeInformer := coreFactory.Core().V1().Nodes().Informer()
	nodeLister := coreFactory.Core().V1().Nodes().Lister()
	nsInformer := coreFactory.Core().V1().Namespaces().Informer()
	nsLister := coreFactory.Core().V1().Namespaces().Lister()

	// Per-node Pod informer (tenant loop). The fields-selector narrows
	// the LIST/WATCH at the apiserver, so the cache only sees Pods
	// scheduled to this host. Built via a TweakListOptionsFunc factory
	// so the rest of corev1 informers in coreFactory remain unscoped
	// (Namespaces are cluster-wide; Nodes are cluster-wide).
	nodeName := os.Getenv("NODE_NAME")
	if nodeName == "" {
		slog.Error("NODE_NAME env required (downward API spec.nodeName)")
		os.Exit(1)
	}
	podFactory := informers.NewSharedInformerFactoryWithOptions(
		clientset, informerResync,
		informers.WithTweakListOptions(func(opts *metav1.ListOptions) {
			opts.FieldSelector = fields.OneTermEqualSelector("spec.nodeName", nodeName).String()
		}),
	)
	podInformer := podFactory.Core().V1().Pods().Informer()
	podLister := podFactory.Core().V1().Pods().Lister()

	// Dynamic informers for the two CRDs. We use unstructured + dynamic
	// instead of code-generated typed clients to keep the build simple
	// (no codegen step) and because v1alpha1 schemas may evolve. The
	// ipaddress / status fields we need are all simple scalar types,
	// so unstructured access is ergonomic enough.
	dynFactory := dynamicinformer.NewDynamicSharedInformerFactory(dynClient, informerResync)
	ctrInformer := dynFactory.ForResource(ctrGVR).Informer()
	ctrLister := dynFactory.ForResource(ctrGVR).Lister()
	cppInformer := dynFactory.ForResource(cppGVR).Informer()
	cppLister := dynFactory.ForResource(cppGVR).Lister()
	cfbInformer := dynFactory.ForResource(cfbGVR).Informer()
	cfbLister := dynFactory.ForResource(cfbGVR).Lister()

	hs := &healthState{}
	r := &reconciler{
		nodes:     nodeLister,
		ctrLister: ctrLister,
		cppLister: cppLister,
		cfbLister: cfbLister,
		ctrClient: dynClient.Resource(ctrGVR),
		cppClient: dynClient.Resource(cppGVR),
		cfbClient: dynClient.Resource(cfbGVR),
		cppGrace:  defaultCppPostClaimGrace,
		now:       time.Now,
		applier:   newRealApplier(),
		trigger:   make(chan struct{}, 1),
		health:    hs,
	}
	tpr := newTenantPortsReconciler(nodeName, podLister, nsLister, r)
	tpr.health = hs

	// Traffic-accounting loop (fourth goroutine; see traffic.go). Shares the
	// Node + Pod listers, so it adds no apiserver watches.
	ta := newTrafficAccountant(nodeName, nodeLister, podLister,
		newRealTrafficNft(), newTrafficPublisher(clientset, nodeName, nodeLister))

	// Peer loop event handlers — Node + the three CRDs. Updates are
	// filtered (informer_filters.go): a status-only CRD update — including
	// the status writes this loop makes on every node — or a kubelet
	// heartbeat on a Node must not kick a reconcile, or the status writers
	// feed themselves. Add/Delete always kick; floorReconcile still ticks.
	if _, err := nodeInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(any) { r.kick(); ta.kick() },
		UpdateFunc: func(oldObj, newObj any) {
			if nodeUpdateNeedsReconcile(oldObj, newObj) {
				r.kick()
				ta.kick()
			}
		},
		DeleteFunc: func(any) { r.kick(); ta.kick() },
	}); err != nil {
		slog.Error("AddEventHandler node", "err", err)
		os.Exit(1)
	}
	for _, inf := range []cache.SharedIndexInformer{ctrInformer, cppInformer, cfbInformer} {
		if _, err := inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc: func(any) { r.kick() },
			UpdateFunc: func(oldObj, newObj any) {
				if crdUpdateNeedsReconcile(oldObj, newObj) {
					r.kick()
				}
			},
			DeleteFunc: func(any) { r.kick() },
		}); err != nil {
			slog.Error("AddEventHandler peer", "err", err)
			os.Exit(1)
		}
	}
	// Tenant loop event handlers — Pods scheduled to this node + any
	// Namespace change (the tenant-namespace classifier reads
	// annotations, so a label/annotation flip should re-tick).
	for _, inf := range []cache.SharedIndexInformer{podInformer, nsInformer} {
		if _, err := inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(any) { tpr.kick() },
			UpdateFunc: func(any, any) { tpr.kick() },
			DeleteFunc: func(any) { tpr.kick() },
		}); err != nil {
			slog.Error("AddEventHandler tenant", "err", err)
			os.Exit(1)
		}
	}
	// Traffic loop — only backup-rclone-shim Pods on this node matter (their
	// IPs feed shim_v{4,6}). The node-scoped Pod informer spans all
	// namespaces, so the shim's `platform` namespace is already in its cache.
	if _, err := podInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			if isBackupShimPod(obj) {
				ta.kick()
			}
		},
		UpdateFunc: func(_, newObj any) {
			if isBackupShimPod(newObj) {
				ta.kick()
			}
		},
		DeleteFunc: func(obj any) {
			if isBackupShimPod(obj) {
				ta.kick()
			}
		},
	}); err != nil {
		slog.Error("AddEventHandler traffic", "err", err)
		os.Exit(1)
	}

	coreFactory.Start(ctx.Done())
	podFactory.Start(ctx.Done())
	dynFactory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(),
		nodeInformer.HasSynced, ctrInformer.HasSynced, cppInformer.HasSynced, cfbInformer.HasSynced,
		podInformer.HasSynced, nsInformer.HasSynced) {
		slog.Error("informer cache sync timed out")
		os.Exit(1)
	}
	slog.Info("informer caches synced — entering reconcile loops",
		"node", nodeName)

	// Health probe: kubelet liveness/readiness lands here. Start before
	// the reconcile loops so kubelet sees /healthz returning 503
	// (warming up) until both loops have reconciled at least once.
	startHealthServer(ctx, hs)

	// F1+F6 Stage B — CrowdSec L4 blocklist reconciler. Spawned in the
	// same WaitGroup as the peer + tenant loops so a clean shutdown
	// drains all three. Defaults to "disabled" mode; in that case the
	// goroutine blocks on ctx.Done().
	//
	// When mode != disabled, wire the LAPI HTTP client + the exclusion
	// builder that reads from the SAME informer listers the peer
	// reconciler uses (no extra apiserver load). Stage A's constructor
	// downgrades enforce→dryrun, so the applier path is reached but
	// the realApplier's applyCrowdsecBlocklist is itself a logging stub
	// in Stage B (real nft writes land in Stage B.5).
	crCsec := newCrowdsecReconciler()
	if crCsec.mode != crowdsecL4ModeDisabled {
		bouncerKey := os.Getenv("BOUNCER_KEY")
		lapiBaseURL := os.Getenv("CROWDSEC_LAPI_URL")
		lapi, lerr := newLAPIClient(lapiBaseURL, bouncerKey)
		if lerr != nil {
			slog.Error("crowdsec-l4-reconciler: LAPI client init failed — staying dormant",
				"err", lerr)
			// Don't fail the pod — peer + tenant reconcilers must still run.
			// Force mode back to disabled so the dormant goroutine exits cleanly.
			crCsec.mode = crowdsecL4ModeDisabled
		} else {
			crCsec.fetchDecisions = func(fctx context.Context) (crowdsecBlocklist, error) {
				return lapi.fetchStream(fctx, true)
			}
			svcCIDR := os.Getenv(envKubernetesServiceCIDR)
			crCsec.computeExclusions = func(_ context.Context) (exclusionSet, error) {
				return buildExclusionSet(nodeLister, ctrLister, cppLister, svcCIDR)
			}
			crCsec.applier = r.applier // share the realApplier the peer loop uses
			slog.Info("crowdsec-l4-reconciler: wired with LAPI + exclusions",
				"lapi_url_override", lapiBaseURL != "",
				"service_cidr_set", svcCIDR != "")
		}
	}

	// Run the loops as separate goroutines with recover() at the
	// boundary so a panic in one loop doesn't crash the pod (and
	// thereby take down the other loop's reconcile cadence).
	//
	// The traffic loop does NOT publish to the health probe: accounting is
	// best-effort and must never get the firewall pod restarted.
	var wg sync.WaitGroup
	wg.Add(4)
	go runWithRecover(&wg, ctx, "peer", r.run)
	go runWithRecover(&wg, ctx, "tenant-ports", tpr.run)
	go runWithRecover(&wg, ctx, "crowdsec-l4", crCsec.run)
	go runWithRecover(&wg, ctx, "traffic", ta.run)
	wg.Wait()
}

// runWithRecover wraps a reconcile-loop goroutine in a recover() so a
// panic logs + the loop restarts (after a small backoff) instead of
// crashing the pod. The panic is logged with stack so post-mortem is
// possible from `kubectl logs`. ctx still drives shutdown — when ctx
// expires, the inner loop returns and runWithRecover exits cleanly.
func runWithRecover(wg *sync.WaitGroup, ctx context.Context, name string, fn func(context.Context)) {
	defer wg.Done()
	for {
		if ctx.Err() != nil {
			return
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("reconcile loop panic — restarting after backoff",
						"loop", name,
						"recover", r,
						"stack", string(debug.Stack()))
				}
			}()
			fn(ctx)
		}()
		// fn returned cleanly (ctx done) — no need to backoff/restart.
		if ctx.Err() != nil {
			return
		}
		// Panic path: brief backoff before restart so a tight
		// crash-loop doesn't pin a CPU. Cancellation aware.
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// run kicks reconcileOnce on informer events and at the floor cadence.
// Errors are logged but never fatal — informer event handlers requeue
// implicitly on next change, the floor ticker drives liveness even if
// no events arrive (e.g. permanent kube-API outage). On a successful
// reconcile we publish a timestamp to the health probe so kubelet
// can detect stalls.
func (r *reconciler) run(ctx context.Context) {
	r.kick() // kick once at start so we don't wait floorReconcile for the first pass
	t := time.NewTicker(floorReconcile)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.trigger:
		case <-t.C:
		}
		if err := r.reconcileOnce(ctx); err != nil {
			slog.Error("reconcile", "err", err)
			continue
		}
		if r.health != nil {
			r.health.markPeerHealthy(time.Now())
		}
	}
}

func (r *reconciler) kick() {
	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

// idleForever blocks on SIGTERM/SIGINT. Reached when the startup probe
// detects missing nft sets — we want a clear error log and a benign
// pause, not a crashloop that spams nft errors at floorReconcile cadence.
func idleForever() {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigs)
	<-sigs
}

// reconciler holds the wiring shared between the peer/CRD reconcile
// loop (driven by reconcileOnce) and the tenant-ports reconcile loop
// (driven by tenantPortsReconciler.run).
type reconciler struct {
	nodes     nodeLister
	ctrLister cache.GenericLister
	cppLister cache.GenericLister
	cfbLister cache.GenericLister
	ctrClient dynamic.NamespaceableResourceInterface
	cppClient dynamic.NamespaceableResourceInterface
	cfbClient dynamic.NamespaceableResourceInterface

	// lastBlacklistFP — last desired blacklist set we applied, for
	// log-on-change only (the apply itself is unconditional/idempotent).
	lastBlacklistFP string

	// lastTenantFP / lastPeerFP — last desired tenant-ports / peer set we
	// applied, used as the in-memory short-circuit for those two paths.
	// They REPLACED a kernel read-back (observe*Fingerprint) that decoded
	// interval sets and could misread a populated set as empty, which made
	// the empty-desired REMOVE path match-and-skip the flush, leaking the
	// deleted members' nft entries (#129). An in-memory cache can't be
	// fooled by the kernel encoding; out-of-band kernel edits self-heal on
	// the next desired change or pod restart (lastFP starts empty).
	lastTenantFP string
	lastPeerFP   string

	// cppGrace is the delay between setting status.claimedAt and
	// deleting the CR. Lets ops/UI observe the claimed state before
	// the resource disappears.
	cppGrace time.Duration

	// now is injectable for deterministic TTL tests.
	now func() time.Time

	// applier writes the desired set state to the kernel via libnftnl
	// netlink. Injectable so unit tests swap a fake — see fakeApplier
	// in reconcile_test.go.
	applier applier

	trigger chan struct{}

	// mu serializes the two reconcile loops' state inspection inside
	// applyPeersIfChanged / applyTenantPortsIfChanged. Each loop reads
	// observed kernel state via the applier, then compares to desired
	// and applies — under r.mu so the two loops can't interleave reads
	// and writes through the shared netlink applier.
	mu sync.Mutex

	// health publishes the most recent successful peer reconcile time
	// so the kubelet liveness/readiness HTTP probe can detect stalls.
	health *healthState
}

// Type assertions (compile-time guarantees that we use the right
// interfaces from k8s libraries even after dependency bumps).
var (
	_ cache.GenericLister = (cache.GenericLister)(nil)
)
