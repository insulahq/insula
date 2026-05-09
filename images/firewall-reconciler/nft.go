// nft set converger using Go libnftnl bindings (github.com/google/nftables).
//
// Replaces the previous `exec.Command("nft", "-f", "-")` approach so the
// reconciler ships a Go-only binary in its container — no /usr/sbin/nft,
// no apt-installed nftables package, no userspace version-skew with the
// host. The library talks netlink directly to the kernel; the kernel
// netfilter wire format is stable across nft binary versions.
//
// Compatibility rule observed 2026-05-09 (incident #2):
//   container nft 1.1.6 wrote set-element attributes that host nft 1.1.3
//   could not read → host nft segfaulted on every `list set`, ssh-blocked
//   the staging cluster. The "container nft >= host nft" rule from
//   incident #1 was directionally correct ONLY for the read path; the
//   write path requires the opposite ("container nft <= host nft"). The
//   intersection is "container nft == host nft" which is impractical
//   across distros.
//
// Switching to direct netlink eliminates the userspace nft from the
// equation. The kernel state ends up encoded by the kernel itself; any
// `nft` binary on any host can read it.

package main

import (
	"errors"
	"fmt"
	"net/netip"
	"sync"

	"github.com/google/nftables"
)

const (
	nftTableName = "filter"
	// Peer reconciler sets — cluster-scope, IP/CIDR keyed.
	setPeersV4   = "cluster_peers_v4"
	setPeersV6   = "cluster_peers_v6"
	setTrustedV4 = "trusted_ranges_v4"
	setTrustedV6 = "trusted_ranges_v6"
	// Tenant-port reconciler sets — node-scope, inet_service (port) keyed.
	setTenantTCP = "tenant_ports_tcp"
	setTenantUDP = "tenant_ports_udp"
)

// peerNftSets — what the peer reconciler writes. Order is deterministic
// so the per-set fingerprint cache works.
type peerNftSets struct {
	PeersV4   []string // bare IPs (e.g. "10.0.0.5")
	PeersV6   []string // bare IPs
	TrustedV4 []string // canonical CIDRs (e.g. "10.0.0.0/16", "1.2.3.4/32")
	TrustedV6 []string // canonical CIDRs
}

// tenantPortSets — what the tenant-port reconciler writes. Each entry is
// either a bare port ("3478") or a port range ("16384-32768"). Sorted +
// deduped so the per-set fingerprint cache short-circuits identical
// ticks.
type tenantPortSets struct {
	TCP []string
	UDP []string
}

// applier wraps the netlink connection plumbing so reconcile loops can
// inject a fake in tests. Two methods, one per reconcile loop, so each
// loop can apply independently without touching the other's sets.
type applier interface {
	applyPeerSets(s peerNftSets) error
	applyTenantPorts(s tenantPortSets) error
}

// realApplier holds an open lasting netlink connection. Reused across
// reconcile ticks; Close on shutdown.
type realApplier struct {
	mu sync.Mutex // serialises kernel writes (one transaction at a time)
}

func newRealApplier() *realApplier {
	return &realApplier{}
}

// applyPeerSets writes the four peer/trusted sets via one batched
// netlink transaction. Two-phase commit:
//   Phase 1: ensure each set exists; commit if any was created so the
//            kernel populates *Set IDs before Phase 2 references them.
//   Phase 2: re-fetch canonical handles, flush + add per set, commit.
//
// Atomicity is per-set, not cross-set — the kernel applies each "flush
// set X" + "add element X" as a unit, but the four sets are sequenced.
// Acceptable: each set gates a different rule chain, momentary
// inconsistency between cluster_peers and trusted_ranges does not
// break correctness.
func (r *realApplier) applyPeerSets(s peerNftSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensureAddrSet(conn, table, setPeersV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setPeersV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setTrustedV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setTrustedV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit set creations: %w", err)
		}
	}

	pV4, err := conn.GetSetByName(table, setPeersV4)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setPeersV4, err)
	}
	pV6, err := conn.GetSetByName(table, setPeersV6)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setPeersV6, err)
	}
	tV4, err := conn.GetSetByName(table, setTrustedV4)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTrustedV4, err)
	}
	tV6, err := conn.GetSetByName(table, setTrustedV6)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTrustedV6, err)
	}

	r.flushAndAddElements(conn, pV4, ipsToElements(s.PeersV4, false))
	r.flushAndAddElements(conn, pV6, ipsToElements(s.PeersV6, true))
	r.flushAndAddElements(conn, tV4, cidrsToElements(s.TrustedV4, false))
	r.flushAndAddElements(conn, tV6, cidrsToElements(s.TrustedV6, true))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit member updates: %w", err)
	}
	return nil
}

// applyTenantPorts writes tenant_ports_{tcp,udp} via the same two-phase
// commit shape as applyPeerSets but with inet_service (16-bit port)
// interval keys instead of address keys.
func (r *realApplier) applyTenantPorts(s tenantPortSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck

	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensurePortSet(conn, table, setTenantTCP); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensurePortSet(conn, table, setTenantUDP); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit tenant set creations: %w", err)
		}
	}

	tcpSet, err := conn.GetSetByName(table, setTenantTCP)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTenantTCP, err)
	}
	udpSet, err := conn.GetSetByName(table, setTenantUDP)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTenantUDP, err)
	}

	r.flushAndAddElements(conn, tcpSet, portsToElements(s.TCP))
	r.flushAndAddElements(conn, udpSet, portsToElements(s.UDP))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit tenant member updates: %w", err)
	}
	return nil
}

// openAndPreflight opens a fresh netlink conn and verifies the inet
// filter table exists. Shared between applyPeerSets and
// applyTenantPorts so the same precondition error surface applies to
// both.
func (r *realApplier) openAndPreflight() (*nftables.Conn, *nftables.Table, error) {
	conn, err := nftables.New()
	if err != nil {
		return nil, nil, fmt.Errorf("netlink open: %w", err)
	}
	table := &nftables.Table{
		Family: nftables.TableFamilyINet,
		Name:   nftTableName,
	}
	tables, err := conn.ListTables()
	if err != nil {
		_ = conn.CloseLasting()
		return nil, nil, fmt.Errorf("list tables: %w", err)
	}
	if !findInetFilterTable(tables) {
		_ = conn.CloseLasting()
		return nil, nil, errors.New("inet filter table not found — bootstrap.sh nftables config not loaded")
	}
	return conn, table, nil
}

// ensureAddrSet returns the *Set handle for `name`, creating it if
// absent. Used for the four IP/CIDR-keyed peer/trusted sets. The bool
// return indicates whether a new set was added to the batch (caller
// flushes after Phase 1 if any was created so the kernel populates
// *Set IDs before Phase 2's element writes resolve them).
func (r *realApplier) ensureAddrSet(conn *nftables.Conn, table *nftables.Table, name string, isV6 bool) (*nftables.Set, bool, error) {
	if existing, err := conn.GetSetByName(table, name); err == nil && existing != nil {
		return existing, false, nil
	}
	keyType := nftables.TypeIPAddr
	if isV6 {
		keyType = nftables.TypeIP6Addr
	}
	set := &nftables.Set{
		Table:    table,
		Name:     name,
		KeyType:  keyType,
		Interval: true,
	}
	if err := conn.AddSet(set, nil); err != nil {
		return nil, false, fmt.Errorf("add set %s: %w", name, err)
	}
	return set, true, nil
}

// ensurePortSet is the inet_service variant of ensureAddrSet — for
// tenant_ports_{tcp,udp}. Same semantics: idempotent fetch-or-create,
// returns true if created so the caller knows to commit Phase 1.
func (r *realApplier) ensurePortSet(conn *nftables.Conn, table *nftables.Table, name string) (*nftables.Set, bool, error) {
	if existing, err := conn.GetSetByName(table, name); err == nil && existing != nil {
		return existing, false, nil
	}
	set := &nftables.Set{
		Table:    table,
		Name:     name,
		KeyType:  nftables.TypeInetService,
		Interval: true,
	}
	if err := conn.AddSet(set, nil); err != nil {
		return nil, false, fmt.Errorf("add set %s: %w", name, err)
	}
	return set, true, nil
}

// flushAndAddElements queues a flush + element-add for the given set.
// Errors from SetAddElements are non-fatal at the queue stage —
// conn.Flush() returns the actual kernel error.
func (r *realApplier) flushAndAddElements(conn *nftables.Conn, set *nftables.Set, elems []nftables.SetElement) {
	conn.FlushSet(set)
	if len(elems) > 0 {
		_ = conn.SetAddElements(set, elems)
	}
}

// ipsToElements converts bare IPs (e.g. "10.0.0.5") to nftables
// interval-set elements. For an interval set with type ipv4_addr, a
// "single IP" is encoded as a degenerate range [ip, ip+1) — start key
// + IntervalEnd marker. The kernel's nft_set_pipapo expects this shape;
// userspace `nft list set` renders it back as a bare IP.
func ipsToElements(ips []string, isV6 bool) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(ips)*2)
	for _, ip := range ips {
		addr, err := netip.ParseAddr(ip)
		if err != nil {
			continue // pre-validated upstream, but defensive
		}
		addr = addr.Unmap()
		if addr.Is4() != !isV6 {
			continue
		}
		next := addr.Next()
		if !next.IsValid() {
			continue // edge: 255.255.255.255 — unrealistic for our use
		}
		out = append(out,
			nftables.SetElement{Key: addrBytes(addr, isV6)},
			nftables.SetElement{Key: addrBytes(next, isV6), IntervalEnd: true},
		)
	}
	return out
}

// cidrsToElements converts CIDRs (e.g. "10.0.0.0/16") to nftables
// interval-set elements: [network_address, network_address + (1<<host_bits)).
func cidrsToElements(cidrs []string, isV6 bool) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(cidrs)*2)
	for _, c := range cidrs {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			continue
		}
		p = p.Masked() // snap to network address
		if p.Addr().Is4() != !isV6 {
			continue
		}
		startBytes := addrBytes(p.Addr(), isV6)
		endBytes, ok := nextNetwork(p.Addr(), p.Bits(), isV6)
		if !ok {
			continue
		}
		out = append(out,
			nftables.SetElement{Key: startBytes},
			nftables.SetElement{Key: endBytes, IntervalEnd: true},
		)
	}
	return out
}

// portsToElements converts ["3478", "16384-32768"] etc. to nftables
// interval-set elements with type inet_service. The kernel encodes
// inet_service as 2 big-endian bytes (uint16). For an interval set, a
// "single port 3478" is a degenerate range [3478, 3479); a "range
// 16384-32768" is [16384, 32769) — IntervalEnd is exclusive, so we add
// 1 to the upper bound.
//
// Edge case: when hi == 65535 (or single port "65535"), the exclusive
// end is 65536 which doesn't fit in uint16. The kernel + userspace
// nft both encode this as a wraparound to 0 — i.e. the IntervalEnd
// key is {0x00, 0x00}, and the kernel's pipapo set comparator treats
// "end == 0 with start > 0" as "end of port space". We mirror that
// convention so a tenant exposing ports up to 65535 produces the same
// kernel state the bash reconciler did via `nft add element`.
//
// Inputs MUST already be validated by tenantPortRegex (digits or
// digits-digits, both <=65535). Out-of-range or unparseable entries
// are silently skipped — the validator upstream is the authoritative
// gate.
func portsToElements(ports []string) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(ports)*2)
	for _, p := range ports {
		lo, hi, ok := parsePortOrRange(p)
		if !ok {
			continue
		}
		// Promote to uint32 so hi==65535 → end==65536 doesn't wrap
		// silently in arithmetic; then truncate to uint16 for the
		// kernel encoding (which expects the wraparound to be the
		// "end of port space" sentinel — see func comment).
		end := uint16((uint32(hi) + 1) & 0xFFFF)
		out = append(out,
			nftables.SetElement{Key: portBytes(lo)},
			nftables.SetElement{Key: portBytes(end), IntervalEnd: true},
		)
	}
	return out
}

// parsePortOrRange accepts "3478" or "16384-32768" and returns
// (lo, hi, ok). Single ports return lo==hi. Bounds: 1..65535.
// Reverse ranges (lo > hi) are rejected. Trims surrounding whitespace.
func parsePortOrRange(s string) (lo, hi uint16, ok bool) {
	s = trimSpaces(s)
	if s == "" {
		return 0, 0, false
	}
	dash := -1
	for i := 0; i < len(s); i++ {
		if s[i] == '-' {
			dash = i
			break
		}
	}
	if dash < 0 {
		v, ok := parsePort(s)
		if !ok {
			return 0, 0, false
		}
		return v, v, true
	}
	a, ok1 := parsePort(s[:dash])
	b, ok2 := parsePort(s[dash+1:])
	if !ok1 || !ok2 || a > b {
		return 0, 0, false
	}
	return a, b, true
}

// parsePort accepts a 1..5-digit decimal in 1..65535. Leading zeros
// allowed (jq-side validation rejects them, but we re-check here for
// defense in depth). Returns (port, true) on success.
func parsePort(s string) (uint16, bool) {
	if s == "" || len(s) > 5 {
		return 0, false
	}
	var v uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + uint32(c-'0')
		if v > 65535 {
			return 0, false
		}
	}
	if v == 0 {
		return 0, false
	}
	return uint16(v), true
}

// trimSpaces strips ASCII whitespace; net/strings is overkill for the
// hot path — nftables interval-set element parsing happens once per
// reconcile tick per port.
func trimSpaces(s string) string {
	for len(s) > 0 && isWS(s[0]) {
		s = s[1:]
	}
	for len(s) > 0 && isWS(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// portBytes returns the 2-byte big-endian encoding of a uint16 — the
// wire format for nftables.TypeInetService. uint16 because inet_service
// keys are exactly 16 bits; the kernel rejects anything else.
func portBytes(p uint16) []byte {
	return []byte{byte(p >> 8), byte(p)}
}

// addrBytes returns the canonical 4- or 16-byte slice for the address.
func addrBytes(a netip.Addr, isV6 bool) []byte {
	if isV6 {
		b := a.As16()
		return b[:]
	}
	b := a.As4()
	return b[:]
}

// nextNetwork returns the start of the next non-overlapping network
// after the given network/prefix. Used as the IntervalEnd key for CIDR
// ranges: for 10.0.0.0/16 → 10.1.0.0; for fd00::/8 → fe00::.
// Returns ok=false on edge cases (overflow at /0, invalid prefix).
func nextNetwork(a netip.Addr, bits int, isV6 bool) ([]byte, bool) {
	totalBits := 32
	if isV6 {
		totalBits = 128
	}
	if bits < 0 || bits > totalBits {
		return nil, false
	}
	hostBits := totalBits - bits
	return addPow2(a, hostBits, isV6), true
}

// addPow2 returns a + (1 << exp), clamping to all-ones on overflow.
// For our use, exp = totalBits - prefix_bits; e.g. /16 v4 → exp=16 →
// add 0x10000.
func addPow2(a netip.Addr, exp int, isV6 bool) []byte {
	var b []byte
	if isV6 {
		x := a.As16()
		b = x[:]
	} else {
		x := a.As4()
		b = x[:]
	}
	// Add 1 at position (len*8 - exp) from the LSB end.
	// Carry-propagate from the right.
	idx := len(b) - 1 - exp/8
	if idx < 0 {
		// /0 — wrap to all-ones (kernel rejects /0 anyway, validator
		// catches; this is defensive).
		for i := range b {
			b[i] = 0xFF
		}
		return b
	}
	carry := uint16(1) << uint(exp%8)
	for i := idx; i >= 0; i-- {
		v := uint16(b[i]) + carry
		b[i] = byte(v & 0xFF)
		carry = v >> 8
		if carry == 0 {
			break
		}
	}
	return b
}

// findInetFilterTable returns true if the kernel has the `inet filter`
// table that bootstrap.sh declares.
func findInetFilterTable(tables []*nftables.Table) bool {
	for _, t := range tables {
		if t.Family == nftables.TableFamilyINet && t.Name == nftTableName {
			return true
		}
	}
	return false
}

// preflightFilterTable opens a netlink connection at startup and
// verifies the inet filter table exists. Bootstrap.sh creates it; if
// absent, nftables.service didn't load on this host and we should
// idle-with-loud-log instead of crashlooping on every applier call.
func preflightFilterTable() error {
	conn, err := nftables.New()
	if err != nil {
		return fmt.Errorf("netlink open: %w", err)
	}
	defer conn.CloseLasting() //nolint:errcheck
	tables, err := conn.ListTables()
	if err != nil {
		return fmt.Errorf("list tables: %w", err)
	}
	if !findInetFilterTable(tables) {
		return errors.New("inet filter table not found in kernel netfilter — bootstrap.sh must run before this reconciler")
	}
	return nil
}
