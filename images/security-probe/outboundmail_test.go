package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestParseOutboundMailTargets(t *testing.T) {
	got, err := parseOutboundMailTargets(" 587 = a.example.test , b.example.test ;25=c.example.test;; 465= ")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Sorted by port; a port listed without hosts is not checked.
	if len(got) != 2 || got[0].port != 25 || got[1].port != 587 {
		t.Fatalf("got %+v, want ports 25 and 587 only", got)
	}
	if strings.Join(got[1].hosts, ",") != "a.example.test,b.example.test" {
		t.Fatalf("587 hosts = %v", got[1].hosts)
	}

	for _, bad := range []string{"25", "x=a.example.test", "0=a.example.test", "70000=a.example.test",
		"25=a.example.test;25=b.example.test", "25=a.example.test:25", "25=http://a.example.test"} {
		if _, err := parseOutboundMailTargets(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

func TestOutboundMailTargetsFromEnv(t *testing.T) {
	def := outboundMailTargetsFromEnv("", false)
	if len(def) != 3 || def[0].port != 25 || def[1].port != 465 || def[2].port != 587 {
		t.Fatalf("unset must give the defaults for 25/465/587, got %+v", def)
	}
	if got := outboundMailTargetsFromEnv("", true); len(got) != 0 {
		t.Fatalf("set but empty turns the check off, got %+v", got)
	}
	if got := outboundMailTargetsFromEnv("nonsense", true); len(got) != 3 {
		t.Fatalf("an invalid value falls back to the defaults, got %+v", got)
	}
	if got := outboundMailTargetsFromEnv("587=a.example.test", true); len(got) != 1 || got[0].port != 587 {
		t.Fatalf("a valid value replaces the defaults, got %+v", got)
	}
}

func TestParseOutboundMailInterval(t *testing.T) {
	cases := map[string]time.Duration{
		"":      defaultOutboundMailInterval,
		"bad":   defaultOutboundMailInterval,
		"-5":    defaultOutboundMailInterval,
		"5":     minOutboundMailInterval,
		"600":   10 * time.Minute,
		"99999": maxOutboundMailInterval,
	}
	for raw, want := range cases {
		if got := parseOutboundMailInterval(raw); got != want {
			t.Errorf("%q: got %s, want %s", raw, got, want)
		}
	}
}

// fakeDial answers per host: nil = accept, else that error.
func fakeDial(answers map[string]error, tried *[]string) dialFunc {
	return func(_ context.Context, _ string, address string) (net.Conn, error) {
		host, _, _ := net.SplitHostPort(address)
		if tried != nil {
			*tried = append(*tried, address)
		}
		err, ok := answers[host]
		if !ok {
			return nil, errors.New("unexpected host " + host)
		}
		if err != nil {
			return nil, err
		}
		c1, c2 := net.Pipe()
		_ = c2.Close()
		return c1, nil
	}
}

var (
	errTimeout = &net.OpError{Op: "dial", Net: "tcp", Err: context.DeadlineExceeded}
	errDNS     = &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}}
	errRefused = &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	errUnreach = &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.EHOSTUNREACH)}
)

func TestProbeOutboundPort(t *testing.T) {
	target := outboundTarget{port: 587, hosts: []string{"a.example.test", "b.example.test"}}

	t.Run("open on the first target that accepts, without trying the rest", func(t *testing.T) {
		var tried []string
		got := probeOutboundPort(context.Background(), fakeDial(map[string]error{"a.example.test": nil}, &tried), target, time.Second)
		if got.Status != outboundOpen || deref(got.Target) != "a.example.test" || got.LatencyMs == nil || got.Detail != nil {
			t.Fatalf("got %+v", got)
		}
		if len(tried) != 1 || tried[0] != "a.example.test:587" {
			t.Fatalf("tried %v", tried)
		}
	})

	t.Run("one target down is not a block", func(t *testing.T) {
		got := probeOutboundPort(context.Background(),
			fakeDial(map[string]error{"a.example.test": errTimeout, "b.example.test": nil}, nil), target, time.Second)
		if got.Status != outboundOpen || deref(got.Target) != "b.example.test" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("every target timing out is a block, and says so per target", func(t *testing.T) {
		got := probeOutboundPort(context.Background(),
			fakeDial(map[string]error{"a.example.test": errTimeout, "b.example.test": errTimeout}, nil), target, 5*time.Second)
		if got.Status != outboundBlocked || got.Target != nil || got.LatencyMs != nil {
			t.Fatalf("got %+v", got)
		}
		if want := "a.example.test timed out after 5s; b.example.test timed out after 5s"; deref(got.Detail) != want {
			t.Fatalf("detail %q, want %q", deref(got.Detail), want)
		}
	})

	t.Run("refused and unreachable are blocks too — the port did not get out", func(t *testing.T) {
		got := probeOutboundPort(context.Background(),
			fakeDial(map[string]error{"a.example.test": errRefused, "b.example.test": errUnreach}, nil), target, time.Second)
		if got.Status != outboundBlocked || deref(got.Detail) != "a.example.test refused the connection; b.example.test unreachable" {
			t.Fatalf("got %+v detail %q", got, deref(got.Detail))
		}
	})

	t.Run("no target resolving says nothing about the port", func(t *testing.T) {
		got := probeOutboundPort(context.Background(),
			fakeDial(map[string]error{"a.example.test": errDNS, "b.example.test": errDNS}, nil), target, time.Second)
		if got.Status != outboundUnknown || !strings.Contains(deref(got.Detail), "did not resolve") {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("one resolving target that times out is a block", func(t *testing.T) {
		got := probeOutboundPort(context.Background(),
			fakeDial(map[string]error{"a.example.test": errDNS, "b.example.test": errTimeout}, nil), target, time.Second)
		if got.Status != outboundBlocked {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("a cancelled check stays unknown", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		got := probeOutboundPort(ctx, fakeDial(map[string]error{}, nil), target, time.Second)
		if got.Status != outboundUnknown {
			t.Fatalf("got %+v", got)
		}
	})
}

// The real dialer against real sockets: a listening port is open, a closed one
// (the kernel answers RST) is a block with "refused".
func TestProbeOutboundPortRealSockets(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	openPort := ln.Addr().(*net.TCPAddr).Port

	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	_ = closed.Close()

	d := &net.Dialer{}
	res := probeOutboundMail(context.Background(), d.DialContext, []outboundTarget{
		{port: openPort, hosts: []string{"127.0.0.1"}},
		{port: closedPort, hosts: []string{"127.0.0.1"}},
	}, 2*time.Second, 15*time.Minute, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))

	if res.CheckedAt != "2026-01-02T03:04:05Z" || res.IntervalSeconds != 900 || len(res.Ports) != 2 {
		t.Fatalf("got %+v", res)
	}
	byPort := map[int]OutboundMailPortWire{res.Ports[0].Port: res.Ports[0], res.Ports[1].Port: res.Ports[1]}
	if byPort[openPort].Status != outboundOpen {
		t.Errorf("listening port: %+v", byPort[openPort])
	}
	if p := byPort[closedPort]; p.Status != outboundBlocked || !strings.Contains(deref(p.Detail), "refused") {
		t.Errorf("closed port: %+v detail %q", p, deref(p.Detail))
	}
}

func TestOutboundMailProberSnapshotAndSignal(t *testing.T) {
	p := &outboundMailProber{
		targets:  []outboundTarget{{port: 25, hosts: []string{"a.example.test"}}},
		interval: time.Minute,
		timeout:  time.Second,
		dial:     fakeDial(map[string]error{"a.example.test": errTimeout}, nil),
		changed:  make(chan struct{}, 1),
	}
	if p.snapshot() != nil {
		t.Fatal("no result before the first check")
	}
	p.checkOnce(context.Background())
	select {
	case <-p.changed:
	default:
		t.Fatal("a finished check must signal the publisher")
	}
	snap := p.snapshot()
	if snap == nil || len(snap.Ports) != 1 || snap.Ports[0].Status != outboundBlocked {
		t.Fatalf("snapshot %+v", snap)
	}
	snap.Ports[0].Status = "mutated"
	if p.snapshot().Ports[0].Status != outboundBlocked {
		t.Fatal("snapshot must be a copy")
	}
}

func TestPublishWritesOutboundMailOnlyWhenChecked(t *testing.T) {
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1.example.test", UID: "u1"}}
	client := fake.NewSimpleClientset(node)
	pub := newConfigMapPublisher(client, "platform-system", "n1.example.test")
	ctx := context.Background()

	if err := pub.publish(ctx, Snapshot{}, MemcgWitnessWire{}, nil, false); err != nil {
		t.Fatalf("publish: %v", err)
	}
	cm, err := client.CoreV1().ConfigMaps("platform-system").Get(ctx, "security-probe-n1.example.test", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if _, ok := cm.Data["outboundMail"]; ok {
		t.Fatal("no outboundMail key before a check finished")
	}

	target := "a.example.test"
	res := &OutboundMailWire{CheckedAt: "2026-01-02T03:04:05Z", IntervalSeconds: 900, Ports: []OutboundMailPortWire{
		{Port: 25, Status: outboundOpen, Target: &target},
	}}
	if err := pub.publish(ctx, Snapshot{}, MemcgWitnessWire{}, res, false); err != nil {
		t.Fatalf("publish: %v", err)
	}
	cm, _ = client.CoreV1().ConfigMaps("platform-system").Get(ctx, "security-probe-n1.example.test", metav1.GetOptions{})
	var got map[string]any
	if err := json.Unmarshal([]byte(cm.Data["outboundMail"]), &got); err != nil {
		t.Fatalf("outboundMail is not JSON: %v (%q)", err, cm.Data["outboundMail"])
	}
	ports, _ := got["ports"].([]any)
	first, _ := ports[0].(map[string]any)
	// The wire keys the backend's zod schema reads.
	for _, k := range []string{"port", "status", "target", "latencyMs", "detail"} {
		if _, ok := first[k]; !ok {
			t.Errorf("port entry has no %q key: %v", k, first)
		}
	}
	if got["checkedAt"] != "2026-01-02T03:04:05Z" || got["intervalSeconds"] != float64(900) {
		t.Errorf("got %v", got)
	}
	if cm.Data["snapshot"] == "" || cm.Data["memcg"] == "" {
		t.Error("the posture and the OOM witness must still be published")
	}

	// A restarted probe publishes before its first check finishes: the
	// previous result stays rather than vanishing for those seconds.
	published := cm.Data["outboundMail"]
	if err := pub.publish(ctx, Snapshot{}, MemcgWitnessWire{}, nil, true); err != nil {
		t.Fatalf("publish: %v", err)
	}
	cm, _ = client.CoreV1().ConfigMaps("platform-system").Get(ctx, "security-probe-n1.example.test", metav1.GetOptions{})
	if cm.Data["outboundMail"] != published {
		t.Fatalf("pending first check dropped the previous result: %q", cm.Data["outboundMail"])
	}
	// Turned off: the key goes.
	if err := pub.publish(ctx, Snapshot{}, MemcgWitnessWire{}, nil, false); err != nil {
		t.Fatalf("publish: %v", err)
	}
	cm, _ = client.CoreV1().ConfigMaps("platform-system").Get(ctx, "security-probe-n1.example.test", metav1.GetOptions{})
	if _, ok := cm.Data["outboundMail"]; ok {
		t.Fatal("a check that is off must not leave an old result behind")
	}
}

func TestProberPending(t *testing.T) {
	on := &outboundMailProber{targets: []outboundTarget{{port: 25, hosts: []string{"a.example.test"}}}, timeout: time.Second,
		dial: fakeDial(map[string]error{"a.example.test": nil}, nil), changed: make(chan struct{}, 1)}
	if !on.pending() {
		t.Fatal("on, before the first check: pending")
	}
	on.checkOnce(context.Background())
	if on.pending() {
		t.Fatal("after the first check: not pending")
	}
	off := &outboundMailProber{changed: make(chan struct{}, 1)}
	if off.pending() {
		t.Fatal("off: never pending")
	}
}

// bootstrap.sh's preflight dials the same targets, so a node is judged the same
// way at install time and afterwards.
func TestBootstrapPreflightUsesTheSameTargets(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/bootstrap.sh")
	if err != nil {
		t.Fatalf("cannot read ../../scripts/bootstrap.sh: %v — if the script moved, update this test, do not delete it", err)
	}
	m := regexp.MustCompile(`(?m)^OUTBOUND_MAIL_PROBE_TARGETS_DEFAULT="([^"]*)"`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("bootstrap.sh defines no OUTBOUND_MAIL_PROBE_TARGETS_DEFAULT")
	}
	if string(m[1]) != defaultOutboundMailTargets {
		t.Fatalf("bootstrap.sh targets\n  %s\ndiffer from the probe's\n  %s", m[1], defaultOutboundMailTargets)
	}
}

// Every default port is one the backend knows how to judge.
func TestDefaultTargetsCoverTheMailPorts(t *testing.T) {
	targets, err := parseOutboundMailTargets(defaultOutboundMailTargets)
	if err != nil {
		t.Fatalf("defaults do not parse: %v", err)
	}
	var ports []string
	for _, tg := range targets {
		ports = append(ports, strconv.Itoa(tg.port))
		if len(tg.hosts) < 2 {
			t.Errorf("port %d has %d target(s): one provider's outage would read as a block", tg.port, len(tg.hosts))
		}
	}
	if strings.Join(ports, ",") != "25,465,587" {
		t.Fatalf("default ports %v", ports)
	}
}
