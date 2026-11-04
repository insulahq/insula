// Outbound mail ports — can this node open a connection on TCP 25, 465 and 587?
//
// Hosting providers block outbound mail ports on some servers (often a newly
// ordered one) to stop spam. Nothing on the node shows it: the host firewall
// accepts the traffic and the provider drops it upstream, so an app on that node
// sees "Connection timed out" on every send, and a mail server placed there
// queues everything it should deliver. The probe dials each port from the host
// network (hostNetwork: true, so the pod's connection IS the node's) and
// publishes the result at data.outboundMail of the probe's ConfigMap. The
// backend's node health and mail health read it.
//
// Targets are the public mail servers of large providers, not the cluster's
// own: the mail server bans sources that open bare connections to many ports,
// and a node's verdict must not depend on another node's provider. A port is
// open when ANY target accepts a TCP connection — it is closed again at once,
// no SMTP is spoken — and blocked when targets resolved but none answered.
// Only DNS failures for every target leave it unknown: that is not evidence
// about the port.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// Port → targets, tried in order until one accepts. Overridable with
	// OUTBOUND_MAIL_PROBE_TARGETS in the same format; a port with no hosts is
	// not checked, and an empty value turns the probe off. bootstrap.sh's
	// preflight carries the same list (OUTBOUND_MAIL_PROBE_TARGETS_DEFAULT) —
	// outboundmail_test.go keeps the two equal.
	defaultOutboundMailTargets = "25=gmail-smtp-in.l.google.com,mta5.am0.yahoodns.net,outlook-com.olc.protection.outlook.com;" +
		"465=smtp.gmail.com,smtp.mail.yahoo.com;" +
		"587=smtp.gmail.com,smtp.office365.com,smtp.mail.yahoo.com"

	// A provider's block does not come and go by the minute; four connections
	// an hour per target is all the check needs, and little enough that no
	// receiving server notices.
	defaultOutboundMailInterval = 15 * time.Minute
	minOutboundMailInterval     = time.Minute
	maxOutboundMailInterval     = 6 * time.Hour

	outboundMailDialTimeout = 5 * time.Second

	outboundOpen    = "open"
	outboundBlocked = "blocked"
	outboundUnknown = "unknown"
)

// OutboundMailPortWire mirrors outboundMailProbePortSchema in
// packages/api-contracts/src/outbound-mail.ts.
type OutboundMailPortWire struct {
	Port   int    `json:"port"`
	Status string `json:"status"`
	// The target that accepted the connection (open only).
	Target    *string `json:"target"`
	LatencyMs *int64  `json:"latencyMs"`
	// What each target answered, when none accepted.
	Detail *string `json:"detail"`
}

// OutboundMailWire mirrors outboundMailProbeSchema.
type OutboundMailWire struct {
	CheckedAt       string                 `json:"checkedAt"`
	IntervalSeconds int                    `json:"intervalSeconds"`
	Ports           []OutboundMailPortWire `json:"ports"`
}

type outboundTarget struct {
	port  int
	hosts []string
}

type dialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// parseOutboundMailTargets reads "port=host,host;port=host". Whitespace around
// items is ignored; a port listed with no hosts is dropped (not checked).
func parseOutboundMailTargets(raw string) ([]outboundTarget, error) {
	var out []outboundTarget
	seen := map[int]bool{}
	for _, entry := range strings.Split(raw, ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		portRaw, hostsRaw, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, fmt.Errorf("%q: want port=host[,host…]", entry)
		}
		port, err := strconv.Atoi(strings.TrimSpace(portRaw))
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("%q: %q is not a TCP port", entry, strings.TrimSpace(portRaw))
		}
		if seen[port] {
			return nil, fmt.Errorf("port %d listed twice", port)
		}
		seen[port] = true
		var hosts []string
		for _, h := range strings.Split(hostsRaw, ",") {
			h = strings.TrimSpace(h)
			if h == "" {
				continue
			}
			if strings.ContainsAny(h, " /:@") {
				return nil, fmt.Errorf("%q: %q is not a host name", entry, h)
			}
			hosts = append(hosts, h)
		}
		if len(hosts) > 0 {
			out = append(out, outboundTarget{port: port, hosts: hosts})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].port < out[j].port })
	return out, nil
}

// outboundMailTargetsFromEnv: unset → the defaults; set but empty → off (nil);
// invalid → the defaults, logged.
func outboundMailTargetsFromEnv(raw string, set bool) []outboundTarget {
	if !set {
		targets, _ := parseOutboundMailTargets(defaultOutboundMailTargets)
		return targets
	}
	targets, err := parseOutboundMailTargets(raw)
	if err != nil {
		slog.Warn("OUTBOUND_MAIL_PROBE_TARGETS invalid — using the defaults", "err", err)
		targets, _ = parseOutboundMailTargets(defaultOutboundMailTargets)
	}
	return targets
}

func parseOutboundMailInterval(raw string) time.Duration {
	if raw == "" {
		return defaultOutboundMailInterval
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		slog.Warn("OUTBOUND_MAIL_PROBE_INTERVAL_SECONDS invalid — using the default",
			"raw", raw, "default", defaultOutboundMailInterval.Seconds())
		return defaultOutboundMailInterval
	}
	d := time.Duration(n) * time.Second
	return min(max(d, minOutboundMailInterval), maxOutboundMailInterval)
}

// dialFailure names a failed dial the way an operator reads it. dns = the
// target did not resolve, which says nothing about the port.
func dialFailure(err error) (reason string, dns bool) {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "did not resolve", true
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return "timed out", false
	}
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused the connection", false
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "unreachable", false
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return "denied by this host", false
	}
	return err.Error(), false
}

func probeOutboundPort(ctx context.Context, dial dialFunc, t outboundTarget, timeout time.Duration) OutboundMailPortWire {
	res := OutboundMailPortWire{Port: t.port, Status: outboundUnknown}
	var failures []string
	answeredDNS := false
	for _, host := range t.hosts {
		if ctx.Err() != nil {
			break
		}
		start := time.Now()
		dctx, cancel := context.WithTimeout(ctx, timeout)
		conn, err := dial(dctx, "tcp", net.JoinHostPort(host, strconv.Itoa(t.port)))
		cancel()
		if err == nil {
			_ = conn.Close()
			ms := time.Since(start).Milliseconds()
			h := host
			return OutboundMailPortWire{Port: t.port, Status: outboundOpen, Target: &h, LatencyMs: &ms}
		}
		reason, dns := dialFailure(err)
		if !dns {
			answeredDNS = true
		}
		if reason == "timed out" {
			reason = fmt.Sprintf("timed out after %s", timeout)
		}
		failures = append(failures, host+" "+reason)
	}
	if answeredDNS {
		res.Status = outboundBlocked
	}
	if len(failures) > 0 {
		d := strings.Join(failures, "; ")
		res.Detail = &d
	}
	return res
}

// probeOutboundMail checks every port at once; the result lists them in port order.
func probeOutboundMail(ctx context.Context, dial dialFunc, targets []outboundTarget, timeout time.Duration, interval time.Duration, now time.Time) OutboundMailWire {
	ports := make([]OutboundMailPortWire, len(targets))
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ports[i] = probeOutboundPort(ctx, dial, t, timeout)
		}()
	}
	wg.Wait()
	return OutboundMailWire{
		CheckedAt:       now.UTC().Format(time.RFC3339),
		IntervalSeconds: int(interval / time.Second),
		Ports:           ports,
	}
}

// outboundMailProber runs the check on its own schedule and holds the latest
// result for the publisher. changed is signalled (never blocking) after each
// check, so the result is published at once rather than on the next tick.
type outboundMailProber struct {
	targets  []outboundTarget
	interval time.Duration
	timeout  time.Duration
	dial     dialFunc

	mu     sync.Mutex
	latest *OutboundMailWire

	changed chan struct{}
}

func newOutboundMailProber() *outboundMailProber {
	raw, set := os.LookupEnv("OUTBOUND_MAIL_PROBE_TARGETS")
	d := &net.Dialer{}
	return &outboundMailProber{
		targets:  outboundMailTargetsFromEnv(raw, set),
		interval: parseOutboundMailInterval(os.Getenv("OUTBOUND_MAIL_PROBE_INTERVAL_SECONDS")),
		timeout:  outboundMailDialTimeout,
		dial:     d.DialContext,
		changed:  make(chan struct{}, 1),
	}
}

func (p *outboundMailProber) run(ctx context.Context) {
	if len(p.targets) == 0 {
		slog.Info("outbound mail check off (OUTBOUND_MAIL_PROBE_TARGETS is empty)")
		return
	}
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		p.checkOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (p *outboundMailProber) checkOnce(ctx context.Context) {
	res := probeOutboundMail(ctx, p.dial, p.targets, p.timeout, p.interval, time.Now())
	if ctx.Err() != nil {
		return
	}
	for _, port := range res.Ports {
		if port.Status != outboundOpen {
			slog.Warn("outbound mail port not open", "port", port.Port, "status", port.Status, "detail", deref(port.Detail))
		}
	}
	p.mu.Lock()
	p.latest = &res
	p.mu.Unlock()
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

// snapshot returns the latest result, or nil before the first check finished
// (and always when the check is off) — the publisher then omits the key.
func (p *outboundMailProber) snapshot() *OutboundMailWire {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.latest == nil {
		return nil
	}
	cp := *p.latest
	cp.Ports = append([]OutboundMailPortWire(nil), p.latest.Ports...)
	return &cp
}

// pending: the check is on but has not finished its first run since start.
func (p *outboundMailProber) pending() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.targets) > 0 && p.latest == nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
