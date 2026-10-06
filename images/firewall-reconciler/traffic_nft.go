// Node traffic accounting — the `inet insula_traffic` nft table.
//
// A dedicated, count-only table, entirely separate from `inet filter`:
//
//	table inet insula_traffic {
//	  set peers_v4 { type ipv4_addr }   # every Internal+External IP of every
//	  set peers_v6 { type ipv6_addr }   # OTHER node
//	  set shim_v4  { type ipv4_addr }   # backup-rclone-shim pod IPs on THIS node
//	  set shim_v6  { type ipv6_addr }
//	  set phys_ifs { type ifname }      # this host's non-virtual interfaces
//	  counter kubeapi_in / _out, etcd_*, kubelet_*, tunnel_*, n2nother_*, backup_*
//	  counter schema_v1                 # structure-version marker
//	  counter epoch_<hex>               # random id chosen at (re)creation
//
//	  chain pre  { type filter hook prerouting priority -90; policy accept;
//	    iifname "lo" return
//	    iifname @phys_ifs ip  daddr @shim_v4 ip  saddr != @peers_v4 counter name backup_in return
//	    iifname @phys_ifs ip6 daddr @shim_v6 ip6 saddr != @peers_v6 counter name backup_in return
//	    ip  saddr @peers_v4 jump n2n_in
//	    ip6 saddr @peers_v6 jump n2n_in }
//	  chain post { type filter hook postrouting priority 90; policy accept;
//	    oifname "lo" return
//	    oifname @phys_ifs ip  saddr @shim_v4 ip  daddr != @peers_v4 counter name backup_out return
//	    oifname @phys_ifs ip6 saddr @shim_v6 ip6 daddr != @peers_v6 counter name backup_out return
//	    ip  daddr @peers_v4 jump n2n_out
//	    ip6 daddr @peers_v6 jump n2n_out }
//	  chain n2n_in / n2n_out {           # first match wins, every rule returns
//	    tcp sport|dport 6443         → kubeapi
//	    tcp sport|dport 2379-2380    → etcd
//	    tcp sport|dport 10250        → kubelet
//	    udp sport|dport 51820-51821, udp sport|dport 4789, meta l4proto 4 → tunnel
//	    anything else                → n2nother }
//	}
//
// SAFETY: this table must never change a verdict. Both base chains are
// `policy accept`, and the only verdicts any rule carries are `return` and
// `jump` — so a packet leaves this table exactly as it entered, and every
// other table's chains see it as before (an nft accept/return in one base
// chain does not stop later base chains on the same hook). The unit tests
// pin that: no rule may carry drop/accept/reject/queue/NAT.
//
// Hook priorities: prerouting -90 runs after dstnat (-100), so a reply to a
// SNATed pod connection already carries the pod IP as daddr; postrouting 90
// runs before srcnat (100), so a pod's own source IP is still visible.
//
// Lifecycle: created if missing, deleted + recreated when its structure
// does not match this binary's (schema marker, counters, chain rule counts),
// otherwise only the five sets are flushed + refilled. `nftables.service`
// reloads (`flush ruleset`) wipe the table; recreating it resets the
// counters and picks a new epoch, which consumers treat as a counter reset.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"strings"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
)

const (
	trafficTableName    = "insula_traffic"
	trafficSchemaMarker = "schema_v1"
	trafficEpochPrefix  = "epoch_"
	trafficEpochBytes   = 8

	trafficSetPeersV4 = "peers_v4"
	trafficSetPeersV6 = "peers_v6"
	trafficSetShimV4  = "shim_v4"
	trafficSetShimV6  = "shim_v6"
	trafficSetPhysIfs = "phys_ifs"

	trafficChainPre    = "pre"
	trafficChainPost   = "post"
	trafficChainN2NIn  = "n2n_in"
	trafficChainN2NOut = "n2n_out"

	trafficPrePriority  = -90
	trafficPostPriority = 90

	trafficDirIn  = "in"
	trafficDirOut = "out"

	// IPv4 / IPv6 address offsets inside the network header (saddr offsets
	// are shared with nft_blacklist_rule.go).
	ipv4DaddrOffset = 16
	ipv6DaddrOffset = 24

	// Transport-header port offsets (TCP and UDP alike).
	thSportOffset = 0
	thDportOffset = 2
	portLen       = 2

	l4ProtoIPIP = 4
	l4ProtoTCP  = 6
	l4ProtoUDP  = 17

	ifNameLen = 16 // IFNAMSIZ
)

// Traffic classes in snapshot / n2n match order. backup is not an n2n
// class — it is matched in the base chains, before the n2n jump.
const (
	classKubeAPI  = "kubeapi"
	classEtcd     = "etcd"
	classKubelet  = "kubelet"
	classTunnel   = "tunnel"
	classN2NOther = "n2nother"
	classBackup   = "backup"
)

var trafficClasses = []string{classKubeAPI, classEtcd, classKubelet, classTunnel, classN2NOther, classBackup}

func trafficCounterName(class, dir string) string { return class + "_" + dir }

// trafficCounterNames lists every named counter the table must hold.
func trafficCounterNames() []string {
	out := make([]string, 0, len(trafficClasses)*2)
	for _, c := range trafficClasses {
		out = append(out, trafficCounterName(c, trafficDirIn), trafficCounterName(c, trafficDirOut))
	}
	return out
}

// portMatch — one protocol + inclusive port range, matched against the
// source port and (separately) the destination port.
type portMatch struct {
	proto  byte
	lo, hi uint16
}

// n2nClass — a node-to-node class: port matches plus bare l4proto matches
// (IPIP has no ports).
type n2nClass struct {
	class    string
	ports    []portMatch
	l4protos []byte
}

// n2nClasses is the first-match-wins order of the n2n chains; anything that
// matches none of them counts as n2nother.
var n2nClasses = []n2nClass{
	{class: classKubeAPI, ports: []portMatch{{l4ProtoTCP, 6443, 6443}}},
	{class: classEtcd, ports: []portMatch{{l4ProtoTCP, 2379, 2380}}},
	{class: classKubelet, ports: []portMatch{{l4ProtoTCP, 10250, 10250}}},
	{class: classTunnel,
		ports:    []portMatch{{l4ProtoUDP, 51820, 51821}, {l4ProtoUDP, 4789, 4789}},
		l4protos: []byte{l4ProtoIPIP}},
}

// trafficDesired is the set content one reconcile writes.
type trafficDesired struct {
	PeersV4 []string // bare IPs
	PeersV6 []string
	ShimV4  []string
	ShimV6  []string
	PhysIfs []string // interface names
}

// counterValue is one named counter's cumulative totals. nft counts IP
// bytes (no link-layer header); packets let a consumer reconciling against
// NIC byte counts add the per-frame header back.
type counterValue struct {
	Bytes   uint64
	Packets uint64
}

// trafficReading is one read of the table's counters.
type trafficReading struct {
	Epoch    string
	Counters map[string]counterValue // keyed by trafficCounterName
}

// trafficNft is the kernel side of the traffic loop. Injectable for tests.
type trafficNft interface {
	// ensure creates (or repairs) the table and writes the desired set
	// content. recreated reports a fresh table (counters reset, new epoch).
	ensure(d trafficDesired) (recreated bool, err error)
	readCounters() (trafficReading, error)
}

// trafficSetIDs carries the batch-local set IDs the lookup expressions use
// to reference sets created in the same transaction.
type trafficSetIDs struct {
	PeersV4, PeersV6, ShimV4, ShimV6, PhysIfs uint32
}

// trafficBatchSetIDs are the NFTA_SET_IDs the rebuild transaction gives the
// five sets so its lookups can reference them before commit. The kernel
// scopes these IDs to one transaction, so fixed values are safe — and they
// MUST be preset: with ID 0, nftables.AddSet allocates from a package-level
// counter guarded only by the per-Conn mutex, which would race with the
// firewall applier's Conn in the other goroutines.
var trafficBatchSetIDs = trafficSetIDs{PeersV4: 1, PeersV6: 2, ShimV4: 3, ShimV6: 4, PhysIfs: 5}

// trafficSets returns the five set definitions with their batch IDs.
func trafficSets(table *nftables.Table) []*nftables.Set {
	ids := trafficBatchSetIDs
	return []*nftables.Set{
		{Table: table, Name: trafficSetPeersV4, KeyType: nftables.TypeIPAddr, ID: ids.PeersV4},
		{Table: table, Name: trafficSetPeersV6, KeyType: nftables.TypeIP6Addr, ID: ids.PeersV6},
		{Table: table, Name: trafficSetShimV4, KeyType: nftables.TypeIPAddr, ID: ids.ShimV4},
		{Table: table, Name: trafficSetShimV6, KeyType: nftables.TypeIP6Addr, ID: ids.ShimV6},
		{Table: table, Name: trafficSetPhysIfs, KeyType: nftables.TypeIFName, ID: ids.PhysIfs},
	}
}

// trafficChains returns the four chains. Both base chains are policy accept.
func trafficChains(table *nftables.Table) (pre, post, n2nIn, n2nOut *nftables.Chain) {
	accept := nftables.ChainPolicyAccept
	pre = &nftables.Chain{
		Name: trafficChainPre, Table: table, Type: nftables.ChainTypeFilter,
		Hooknum:  nftables.ChainHookPrerouting,
		Priority: nftables.ChainPriorityRef(trafficPrePriority),
		Policy:   &accept,
	}
	post = &nftables.Chain{
		Name: trafficChainPost, Table: table, Type: nftables.ChainTypeFilter,
		Hooknum:  nftables.ChainHookPostrouting,
		Priority: nftables.ChainPriorityRef(trafficPostPriority),
		Policy:   &accept,
	}
	n2nIn = &nftables.Chain{Name: trafficChainN2NIn, Table: table}
	n2nOut = &nftables.Chain{Name: trafficChainN2NOut, Table: table}
	return pre, post, n2nIn, n2nOut
}

// trafficRuleExprs returns each chain's rules (as expression lists) in
// order, keyed by chain name. Pure — the unit tests inspect it directly.
func trafficRuleExprs(ids trafficSetIDs) map[string][][]expr.Any {
	return map[string][][]expr.Any{
		trafficChainPre:    baseChainExprs(trafficDirIn, ids),
		trafficChainPost:   baseChainExprs(trafficDirOut, ids),
		trafficChainN2NIn:  n2nChainExprs(trafficDirIn),
		trafficChainN2NOut: n2nChainExprs(trafficDirOut),
	}
}

// trafficExpectedRuleCounts is the per-chain rule count of a current table.
func trafficExpectedRuleCounts() map[string]int {
	out := map[string]int{}
	for chain, rules := range trafficRuleExprs(trafficSetIDs{}) {
		out[chain] = len(rules)
	}
	return out
}

// baseChainExprs builds `pre` (dir=in: iifname, peer = saddr, shim = daddr)
// or `post` (dir=out: oifname, peer = daddr, shim = saddr).
func baseChainExprs(dir string, ids trafficSetIDs) [][]expr.Any {
	ifKey, jumpTo := expr.MetaKeyIIFNAME, trafficChainN2NIn
	if dir == trafficDirOut {
		ifKey, jumpTo = expr.MetaKeyOIFNAME, trafficChainN2NOut
	}
	backup := trafficCounterName(classBackup, dir)

	type family struct {
		nfproto                byte
		saddrOff, daddrOff, ln uint32
		peerSet, shimSet       string
		peerID, shimID         uint32
	}
	fams := []family{
		{nfprotoIPv4, ipv4SaddrOffset, ipv4DaddrOffset, ipv4SaddrLen, trafficSetPeersV4, trafficSetShimV4, ids.PeersV4, ids.ShimV4},
		{nfprotoIPv6, ipv6SaddrOffset, ipv6DaddrOffset, ipv6SaddrLen, trafficSetPeersV6, trafficSetShimV6, ids.PeersV6, ids.ShimV6},
	}

	rules := [][]expr.Any{{
		&expr.Meta{Key: ifKey, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: ifNameBytes("lo")},
		&expr.Verdict{Kind: expr.VerdictReturn},
	}}
	for _, f := range fams {
		peerOff, shimOff := f.saddrOff, f.daddrOff // in: peer=saddr, shim=daddr
		if dir == trafficDirOut {
			peerOff, shimOff = f.daddrOff, f.saddrOff
		}
		rules = append(rules, []expr.Any{
			&expr.Meta{Key: ifKey, Register: 1},
			&expr.Lookup{SourceRegister: 1, SetName: trafficSetPhysIfs, SetID: ids.PhysIfs},
			&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{f.nfproto}},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: shimOff, Len: f.ln},
			&expr.Lookup{SourceRegister: 1, SetName: f.shimSet, SetID: f.shimID},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: peerOff, Len: f.ln},
			&expr.Lookup{SourceRegister: 1, SetName: f.peerSet, SetID: f.peerID, Invert: true},
			counterRef(backup),
			&expr.Verdict{Kind: expr.VerdictReturn},
		})
	}
	for _, f := range fams {
		peerOff := f.saddrOff
		if dir == trafficDirOut {
			peerOff = f.daddrOff
		}
		rules = append(rules, []expr.Any{
			&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{f.nfproto}},
			&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseNetworkHeader, Offset: peerOff, Len: f.ln},
			&expr.Lookup{SourceRegister: 1, SetName: f.peerSet, SetID: f.peerID},
			&expr.Verdict{Kind: expr.VerdictJump, Chain: jumpTo},
		})
	}
	return rules
}

// n2nChainExprs builds n2n_in / n2n_out: per class, a source-port rule and
// a destination-port rule for every port match, then bare l4proto rules,
// then the n2nother catch-all. Every rule ends in `return`.
func n2nChainExprs(dir string) [][]expr.Any {
	var rules [][]expr.Any
	for _, c := range n2nClasses {
		counter := trafficCounterName(c.class, dir)
		for _, pm := range c.ports {
			for _, off := range []uint32{thSportOffset, thDportOffset} {
				rules = append(rules, []expr.Any{
					&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
					&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{pm.proto}},
					&expr.Payload{DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: off, Len: portLen},
					portMatchExpr(pm.lo, pm.hi),
					counterRef(counter),
					&expr.Verdict{Kind: expr.VerdictReturn},
				})
			}
		}
		for _, proto := range c.l4protos {
			rules = append(rules, []expr.Any{
				&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{proto}},
				counterRef(counter),
				&expr.Verdict{Kind: expr.VerdictReturn},
			})
		}
	}
	return append(rules, []expr.Any{
		counterRef(trafficCounterName(classN2NOther, dir)),
		&expr.Verdict{Kind: expr.VerdictReturn},
	})
}

// portMatchExpr compares register 1 (a loaded port) against one port or an
// inclusive range.
func portMatchExpr(lo, hi uint16) expr.Any {
	if lo == hi {
		return &expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: portBytes(lo)}
	}
	return &expr.Range{Op: expr.CmpOpEq, Register: 1, FromData: portBytes(lo), ToData: portBytes(hi)}
}

func counterRef(name string) expr.Any {
	return &expr.Objref{Type: int(nftables.ObjTypeCounter), Name: name}
}

// ifNameBytes is the IFNAMSIZ, NUL-padded encoding nft uses for ifname
// keys and `iifname "<x>"` comparisons.
func ifNameBytes(name string) []byte {
	b := make([]byte, ifNameLen)
	copy(b, name)
	return b
}

// trafficSetElements converts the desired content into set elements, keyed
// by set name. Unparseable / wrong-family IPs and over-long interface names
// are skipped (the inputs are pre-validated; this is defensive).
func trafficSetElements(d trafficDesired) map[string][]nftables.SetElement {
	ips := func(list []string, v6 bool) []nftables.SetElement {
		out := make([]nftables.SetElement, 0, len(list))
		for _, s := range list {
			a, err := netip.ParseAddr(s)
			if err != nil {
				continue
			}
			a = a.Unmap()
			if a.Is4() == v6 {
				continue
			}
			out = append(out, nftables.SetElement{Key: addrBytes(a, v6)})
		}
		return out
	}
	ifs := make([]nftables.SetElement, 0, len(d.PhysIfs))
	for _, n := range d.PhysIfs {
		if n == "" || len(n) >= ifNameLen {
			continue
		}
		ifs = append(ifs, nftables.SetElement{Key: ifNameBytes(n)})
	}
	return map[string][]nftables.SetElement{
		trafficSetPeersV4: ips(d.PeersV4, false),
		trafficSetPeersV6: ips(d.PeersV6, true),
		trafficSetShimV4:  ips(d.ShimV4, false),
		trafficSetShimV6:  ips(d.ShimV6, true),
		trafficSetPhysIfs: ifs,
	}
}

// trafficStructureCurrent reports whether an existing table matches this
// binary's structure: schema marker, exactly one well-formed epoch marker,
// every counter, and each chain's expected rule count. Pure.
func trafficStructureCurrent(objNames []string, ruleCounts map[string]int) bool {
	have := make(map[string]bool, len(objNames))
	epochs := 0
	for _, n := range objNames {
		have[n] = true
		if strings.HasPrefix(n, trafficEpochPrefix) {
			if !validEpoch(strings.TrimPrefix(n, trafficEpochPrefix)) {
				return false
			}
			epochs++
		}
	}
	if !have[trafficSchemaMarker] || epochs != 1 {
		return false
	}
	for _, c := range trafficCounterNames() {
		if !have[c] {
			return false
		}
	}
	for chain, want := range trafficExpectedRuleCounts() {
		if got, ok := ruleCounts[chain]; !ok || got != want {
			return false
		}
	}
	return true
}

// trafficReadingFromObjects extracts the epoch + byte counters from the
// table's objects. Errors when the table is not in its current shape, so a
// half-built or foreign table is never published.
func trafficReadingFromObjects(objs []nftables.Obj) (trafficReading, error) {
	reading := trafficReading{Counters: map[string]counterValue{}}
	schema := false
	for _, o := range objs {
		name, val, ok := counterNameValue(o)
		if !ok {
			continue
		}
		switch {
		case name == trafficSchemaMarker:
			schema = true
		case strings.HasPrefix(name, trafficEpochPrefix):
			reading.Epoch = strings.TrimPrefix(name, trafficEpochPrefix)
		default:
			reading.Counters[name] = val
		}
	}
	if !schema || !validEpoch(reading.Epoch) {
		return trafficReading{}, errors.New("insula_traffic table has no schema/epoch marker")
	}
	for _, c := range trafficCounterNames() {
		if _, ok := reading.Counters[c]; !ok {
			return trafficReading{}, fmt.Errorf("insula_traffic table is missing counter %s", c)
		}
	}
	return reading, nil
}

// counterNameValue reads a counter object in either the legacy
// (*CounterObj, what GetObjects returns) or the NamedObj shape.
func counterNameValue(o nftables.Obj) (string, counterValue, bool) {
	switch v := o.(type) {
	case *nftables.CounterObj:
		return v.Name, counterValue{Bytes: v.Bytes, Packets: v.Packets}, true
	case *nftables.NamedObj:
		if v.Type != nftables.ObjTypeCounter {
			return "", counterValue{}, false
		}
		if c, ok := v.Obj.(*expr.Counter); ok {
			return v.Name, counterValue{Bytes: c.Bytes, Packets: c.Packets}, true
		}
	}
	return "", counterValue{}, false
}

func validEpoch(s string) bool {
	if len(s) != trafficEpochBytes*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func newTrafficEpoch() (string, error) {
	b := make([]byte, trafficEpochBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("epoch: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func trafficTable() *nftables.Table {
	return &nftables.Table{Family: nftables.TableFamilyINet, Name: trafficTableName}
}
