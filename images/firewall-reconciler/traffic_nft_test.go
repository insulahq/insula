package main

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
)

var testSetIDs = trafficSetIDs{PeersV4: 11, PeersV6: 12, ShimV4: 13, ShimV6: 14, PhysIfs: 15}

func TestTrafficChains_baseChainHooks(t *testing.T) {
	table := trafficTable()
	pre, post, n2nIn, n2nOut := trafficChains(table)

	check := func(c *nftables.Chain, hook *nftables.ChainHook, prio int32) {
		t.Helper()
		if c.Type != nftables.ChainTypeFilter {
			t.Errorf("%s: type = %q, want filter", c.Name, c.Type)
		}
		if c.Hooknum == nil || *c.Hooknum != *hook {
			t.Errorf("%s: hook = %v, want %v", c.Name, c.Hooknum, *hook)
		}
		if c.Priority == nil || int32(*c.Priority) != prio {
			t.Errorf("%s: priority = %v, want %d", c.Name, c.Priority, prio)
		}
		if c.Policy == nil || *c.Policy != nftables.ChainPolicyAccept {
			t.Errorf("%s: policy must be accept, got %v", c.Name, c.Policy)
		}
		if c.Table != table {
			t.Errorf("%s: wrong table", c.Name)
		}
	}
	check(pre, nftables.ChainHookPrerouting, -90)
	check(post, nftables.ChainHookPostrouting, 90)

	// -90 sits after dstnat (-100); 90 sits before srcnat (100).
	if !(int32(*pre.Priority) > int32(*nftables.ChainPriorityNATDest)) {
		t.Error("pre must run after dstnat")
	}
	if !(int32(*post.Priority) < int32(*nftables.ChainPriorityNATSource)) {
		t.Error("post must run before srcnat")
	}
	for _, c := range []*nftables.Chain{n2nIn, n2nOut} {
		if c.Hooknum != nil || c.Priority != nil || c.Policy != nil {
			t.Errorf("%s must be a regular (non-base) chain", c.Name)
		}
	}
	if n2nIn.Name != "n2n_in" || n2nOut.Name != "n2n_out" || pre.Name != "pre" || post.Name != "post" {
		t.Error("chain names drifted from the documented contract")
	}
	if table.Name != "insula_traffic" || table.Family != nftables.TableFamilyINet {
		t.Errorf("table = %s/%v, want inet insula_traffic", table.Name, table.Family)
	}
}

// TestTrafficRules_neverChangeVerdicts is the safety invariant: every
// expression is from a count-only allowlist, the only verdicts are return /
// jump, and every rule ends in one of them.
func TestTrafficRules_neverChangeVerdicts(t *testing.T) {
	for chain, rules := range trafficRuleExprs(testSetIDs) {
		if len(rules) == 0 {
			t.Fatalf("%s: no rules", chain)
		}
		for i, r := range rules {
			for _, e := range r {
				switch v := e.(type) {
				case *expr.Meta, *expr.Cmp, *expr.Payload, *expr.Lookup, *expr.Range, *expr.Objref:
				case *expr.Verdict:
					if v.Kind != expr.VerdictReturn && v.Kind != expr.VerdictJump {
						t.Errorf("%s rule %d: verdict kind %v — only return/jump allowed", chain, i, v.Kind)
					}
				default:
					t.Errorf("%s rule %d: expression %T outside the count-only allowlist", chain, i, e)
				}
			}
			last, ok := r[len(r)-1].(*expr.Verdict)
			if !ok || (last.Kind != expr.VerdictReturn && last.Kind != expr.VerdictJump) {
				t.Errorf("%s rule %d must end in return/jump, ends in %T", chain, i, r[len(r)-1])
			}
			for _, e := range r[:len(r)-1] {
				if _, isVerdict := e.(*expr.Verdict); isVerdict {
					t.Errorf("%s rule %d: verdict before the end of the rule", chain, i)
				}
			}
		}
	}
}

func counterOf(rule []expr.Any) string {
	for _, e := range rule {
		if o, ok := e.(*expr.Objref); ok {
			return o.Name
		}
	}
	return ""
}

func verdictOf(rule []expr.Any) *expr.Verdict {
	v, _ := rule[len(rule)-1].(*expr.Verdict)
	return v
}

func TestTrafficRules_n2nClassOrder(t *testing.T) {
	for _, dir := range []string{"in", "out"} {
		rules := trafficRuleExprs(testSetIDs)["n2n_"+dir]
		var got []string
		for _, r := range rules {
			got = append(got, counterOf(r))
		}
		want := []string{
			"kubeapi", "kubeapi", // sport, dport 6443
			"etcd", "etcd", // 2379-2380
			"kubelet", "kubelet", // 10250
			"tunnel", "tunnel", "tunnel", "tunnel", "tunnel", // 51820-51821 ×2, 4789 ×2, IPIP
			"n2nother",
		}
		for i := range want {
			want[i] += "_" + dir
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("n2n_%s counter order =\n  %v\nwant\n  %v", dir, got, want)
		}
		for i, r := range rules {
			if v := verdictOf(r); v == nil || v.Kind != expr.VerdictReturn {
				t.Errorf("n2n_%s rule %d must end in return", dir, i)
			}
		}
		// The catch-all is unconditional: counter + return only.
		if last := rules[len(rules)-1]; len(last) != 2 {
			t.Errorf("n2n_%s catch-all must be `counter name n2nother_%s return`, got %d exprs", dir, dir, len(last))
		}
	}
}

// portRuleShape decodes an n2n port rule into (proto, offset, lo, hi).
func portRuleShape(t *testing.T, r []expr.Any) (proto byte, off uint32, lo, hi []byte) {
	t.Helper()
	m, ok1 := r[0].(*expr.Meta)
	c, ok2 := r[1].(*expr.Cmp)
	p, ok3 := r[2].(*expr.Payload)
	if !ok1 || !ok2 || !ok3 || m.Key != expr.MetaKeyL4PROTO || p.Base != expr.PayloadBaseTransportHeader || p.Len != 2 {
		t.Fatalf("not an l4proto + transport-port rule: %#v", r)
	}
	switch pm := r[3].(type) {
	case *expr.Cmp:
		return c.Data[0], p.Offset, pm.Data, pm.Data
	case *expr.Range:
		return c.Data[0], p.Offset, pm.FromData, pm.ToData
	}
	t.Fatalf("rule %#v has no port match", r)
	return 0, 0, nil, nil
}

func TestTrafficRules_n2nPortsAndProtocols(t *testing.T) {
	rules := trafficRuleExprs(testSetIDs)["n2n_in"]
	type shape struct {
		proto  byte
		off    uint32
		lo, hi uint16
	}
	want := []shape{
		{6, 0, 6443, 6443}, {6, 2, 6443, 6443},
		{6, 0, 2379, 2380}, {6, 2, 2379, 2380},
		{6, 0, 10250, 10250}, {6, 2, 10250, 10250},
		{17, 0, 51820, 51821}, {17, 2, 51820, 51821},
		{17, 0, 4789, 4789}, {17, 2, 4789, 4789},
	}
	for i, w := range want {
		proto, off, lo, hi := portRuleShape(t, rules[i])
		if proto != w.proto || off != w.off || !bytes.Equal(lo, portBytes(w.lo)) || !bytes.Equal(hi, portBytes(w.hi)) {
			t.Errorf("rule %d = proto %d off %d %v-%v, want %+v", i, proto, off, lo, hi, w)
		}
	}
	// IPIP: meta l4proto 4, no port load.
	ipip := rules[10]
	if m, ok := ipip[0].(*expr.Meta); !ok || m.Key != expr.MetaKeyL4PROTO {
		t.Fatalf("IPIP rule must match meta l4proto: %#v", ipip)
	}
	if c, ok := ipip[1].(*expr.Cmp); !ok || !bytes.Equal(c.Data, []byte{4}) {
		t.Errorf("IPIP rule must compare l4proto == 4: %#v", ipip[1])
	}
	if counterOf(ipip) != "tunnel_in" {
		t.Errorf("IPIP counts as %q, want tunnel_in", counterOf(ipip))
	}
}

func TestTrafficRules_loExclusionFirst(t *testing.T) {
	exprs := trafficRuleExprs(testSetIDs)
	for chain, key := range map[string]expr.MetaKey{"pre": expr.MetaKeyIIFNAME, "post": expr.MetaKeyOIFNAME} {
		first := exprs[chain][0]
		m, ok := first[0].(*expr.Meta)
		if !ok || m.Key != key {
			t.Fatalf("%s rule 0 must load the %v interface name, got %#v", chain, key, first[0])
		}
		c, ok := first[1].(*expr.Cmp)
		if !ok || c.Op != expr.CmpOpEq || !bytes.Equal(c.Data, append([]byte("lo"), make([]byte, 14)...)) {
			t.Fatalf("%s rule 0 must compare == \"lo\" (IFNAMSIZ padded), got %#v", chain, first[1])
		}
		if v := verdictOf(first); v == nil || v.Kind != expr.VerdictReturn || len(first) != 3 {
			t.Fatalf("%s rule 0 must be exactly `…name \"lo\" return`", chain)
		}
	}
}

func lookups(rule []expr.Any) []*expr.Lookup {
	var out []*expr.Lookup
	for _, e := range rule {
		if l, ok := e.(*expr.Lookup); ok {
			out = append(out, l)
		}
	}
	return out
}

func payloadOffsets(rule []expr.Any) []uint32 {
	var out []uint32
	for _, e := range rule {
		if p, ok := e.(*expr.Payload); ok {
			if p.Base != expr.PayloadBaseNetworkHeader {
				return nil
			}
			out = append(out, p.Offset)
		}
	}
	return out
}

func TestTrafficRules_backupAndJump(t *testing.T) {
	exprs := trafficRuleExprs(testSetIDs)
	type want struct {
		counter   string
		ifKey     expr.MetaKey
		offsets   []uint32 // shim addr, then peer addr
		shimSet   string
		shimID    uint32
		peerSet   string
		peerID    uint32
		jumpChain string
		jumpOff   uint32
	}
	cases := map[string][]want{
		"pre": {
			{"backup_in", expr.MetaKeyIIFNAME, []uint32{16, 12}, "shim_v4", 13, "peers_v4", 11, "n2n_in", 12},
			{"backup_in", expr.MetaKeyIIFNAME, []uint32{24, 8}, "shim_v6", 14, "peers_v6", 12, "n2n_in", 8},
		},
		"post": {
			{"backup_out", expr.MetaKeyOIFNAME, []uint32{12, 16}, "shim_v4", 13, "peers_v4", 11, "n2n_out", 16},
			{"backup_out", expr.MetaKeyOIFNAME, []uint32{8, 24}, "shim_v6", 14, "peers_v6", 12, "n2n_out", 24},
		},
	}
	for chain, fams := range cases {
		rules := exprs[chain]
		if len(rules) != 5 {
			t.Fatalf("%s: %d rules, want 5 (lo, backup v4/v6, jump v4/v6)", chain, len(rules))
		}
		for i, w := range fams {
			backup := rules[1+i]
			if counterOf(backup) != w.counter {
				t.Errorf("%s backup rule %d counts %q, want %q", chain, i, counterOf(backup), w.counter)
			}
			if m, ok := backup[0].(*expr.Meta); !ok || m.Key != w.ifKey {
				t.Errorf("%s backup rule %d must start with the %v interface load", chain, i, w.ifKey)
			}
			ls := lookups(backup)
			if len(ls) != 3 ||
				ls[0].SetName != "phys_ifs" || ls[0].SetID != 15 || ls[0].Invert ||
				ls[1].SetName != w.shimSet || ls[1].SetID != w.shimID || ls[1].Invert ||
				ls[2].SetName != w.peerSet || ls[2].SetID != w.peerID || !ls[2].Invert {
				t.Errorf("%s backup rule %d lookups = %+v, want phys_ifs, %s, != %s", chain, i, ls, w.shimSet, w.peerSet)
			}
			if got := payloadOffsets(backup); !reflect.DeepEqual(got, w.offsets) {
				t.Errorf("%s backup rule %d payload offsets = %v, want %v", chain, i, got, w.offsets)
			}
			if v := verdictOf(backup); v == nil || v.Kind != expr.VerdictReturn {
				t.Errorf("%s backup rule %d must return", chain, i)
			}

			jump := rules[3+i]
			jl := lookups(jump)
			if len(jl) != 1 || jl[0].SetName != w.peerSet || jl[0].SetID != w.peerID || jl[0].Invert {
				t.Errorf("%s jump rule %d lookups = %+v, want @%s", chain, i, jl, w.peerSet)
			}
			if got := payloadOffsets(jump); !reflect.DeepEqual(got, []uint32{w.jumpOff}) {
				t.Errorf("%s jump rule %d payload offsets = %v, want [%d]", chain, i, got, w.jumpOff)
			}
			if v := verdictOf(jump); v == nil || v.Kind != expr.VerdictJump || v.Chain != w.jumpChain {
				t.Errorf("%s jump rule %d verdict = %+v, want jump %s", chain, i, v, w.jumpChain)
			}
			if counterOf(jump) != "" {
				t.Errorf("%s jump rule %d must not count (the n2n chain does)", chain, i)
			}
		}
	}
}

func TestTrafficCounterNames(t *testing.T) {
	got := strings.Join(trafficCounterNames(), ",")
	want := "kubeapi_in,kubeapi_out,etcd_in,etcd_out,kubelet_in,kubelet_out,tunnel_in,tunnel_out,n2nother_in,n2nother_out,backup_in,backup_out"
	if got != want {
		t.Errorf("counters = %s\nwant %s", got, want)
	}
	// Every counter a rule references must exist.
	defined := map[string]bool{}
	for _, n := range trafficCounterNames() {
		defined[n] = true
	}
	for chain, rules := range trafficRuleExprs(testSetIDs) {
		for i, r := range rules {
			if c := counterOf(r); c != "" && !defined[c] {
				t.Errorf("%s rule %d references undefined counter %q", chain, i, c)
			}
		}
	}
}

func currentObjNames() []string {
	return append([]string{"schema_v1", "epoch_0123456789abcdef"}, trafficCounterNames()...)
}

func TestTrafficStructureCurrent(t *testing.T) {
	counts := trafficExpectedRuleCounts()
	if counts["pre"] != 5 || counts["post"] != 5 || counts["n2n_in"] != 12 || counts["n2n_out"] != 12 {
		t.Fatalf("expected rule counts drifted: %v", counts)
	}
	withCount := func(chain string, n int) map[string]int {
		c := trafficExpectedRuleCounts()
		c[chain] = n
		return c
	}
	without := func(names []string, drop string) []string {
		var out []string
		for _, n := range names {
			if n != drop {
				out = append(out, n)
			}
		}
		return out
	}
	missingChain := trafficExpectedRuleCounts()
	delete(missingChain, "n2n_out")

	cases := []struct {
		name   string
		objs   []string
		counts map[string]int
		want   bool
	}{
		{"complete", currentObjNames(), counts, true},
		{"no schema marker (older/foreign table)", without(currentObjNames(), "schema_v1"), counts, false},
		{"no epoch", without(currentObjNames(), "epoch_0123456789abcdef"), counts, false},
		{"two epochs", append(currentObjNames(), "epoch_fedcba9876543210"), counts, false},
		{"malformed epoch", append(without(currentObjNames(), "epoch_0123456789abcdef"), "epoch_xyz"), counts, false},
		{"missing counter", without(currentObjNames(), "backup_out"), counts, false},
		{"rule flushed out-of-band", currentObjNames(), withCount("pre", 0), false},
		{"chain missing", currentObjNames(), missingChain, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := trafficStructureCurrent(tc.objs, tc.counts); got != tc.want {
				t.Errorf("trafficStructureCurrent = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTrafficReadingFromObjects(t *testing.T) {
	table := trafficTable()
	var objs []nftables.Obj
	for i, n := range currentObjNames() {
		objs = append(objs, &nftables.CounterObj{Table: table, Name: n, Bytes: uint64(i * 1000), Packets: uint64(i)})
	}
	// A NamedObj-shaped counter is read too.
	objs[2] = &nftables.NamedObj{Table: table, Name: "kubeapi_in", Type: nftables.ObjTypeCounter, Obj: &expr.Counter{Bytes: 4242, Packets: 42}}

	r, err := trafficReadingFromObjects(objs)
	if err != nil {
		t.Fatalf("trafficReadingFromObjects: %v", err)
	}
	if r.Epoch != "0123456789abcdef" {
		t.Errorf("epoch = %q", r.Epoch)
	}
	if r.Counters["kubeapi_in"] != (counterValue{4242, 42}) || r.Counters["backup_out"] != (counterValue{13000, 13}) {
		t.Errorf("counters = %v", r.Counters)
	}
	if _, leaked := r.Counters["schema_v1"]; leaked {
		t.Error("markers must not appear as counters")
	}

	if _, err := trafficReadingFromObjects(objs[1:]); err == nil {
		t.Error("missing schema marker must error (never publish a foreign table)")
	}
	if _, err := trafficReadingFromObjects(objs[:len(objs)-1]); err == nil {
		t.Error("missing counter must error")
	}
}

func TestTrafficSetElements(t *testing.T) {
	el := trafficSetElements(trafficDesired{
		PeersV4: []string{"10.0.0.2", "::ffff:10.0.0.3", "fd00::9", "bogus"},
		PeersV6: []string{"fd00::2", "10.0.0.9"},
		ShimV4:  []string{"10.42.1.7"},
		PhysIfs: []string{"eth0", "a-name-that-is-too-long", ""},
	})
	keys := func(set string) [][]byte {
		var out [][]byte
		for _, e := range el[set] {
			out = append(out, e.Key)
		}
		return out
	}
	if got := keys("peers_v4"); len(got) != 2 || !bytes.Equal(got[0], []byte{10, 0, 0, 2}) || !bytes.Equal(got[1], []byte{10, 0, 0, 3}) {
		t.Errorf("peers_v4 keys = %v (mapped v4 must unmap; v6/bogus skipped)", got)
	}
	if got := keys("peers_v6"); len(got) != 1 || len(got[0]) != 16 {
		t.Errorf("peers_v6 keys = %v", got)
	}
	if got := keys("shim_v4"); len(got) != 1 {
		t.Errorf("shim_v4 keys = %v", got)
	}
	if got := keys("shim_v6"); len(got) != 0 {
		t.Errorf("shim_v6 keys = %v, want none", got)
	}
	if got := keys("phys_ifs"); len(got) != 1 || !bytes.Equal(got[0], ifNameBytes("eth0")) || len(got[0]) != 16 {
		t.Errorf("phys_ifs keys = %v, want only padded eth0", got)
	}
	for _, s := range trafficSets(trafficTable()) {
		if s.Interval || s.HasTimeout || s.Constant {
			t.Errorf("set %s must be a plain hash set", s.Name)
		}
	}
}

func TestNewTrafficEpoch(t *testing.T) {
	a, err := newTrafficEpoch()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newTrafficEpoch()
	if !validEpoch(a) || !validEpoch(b) || a == b {
		t.Errorf("epochs %q / %q must be valid and distinct", a, b)
	}
}

// TestTrafficSets_presetBatchIDs: every set carries a preset, unique,
// non-zero ID (so nftables.AddSet never touches its package-level ID
// counter, which is not safe across Conns in different goroutines), and the
// rebuild's lookups reference exactly those IDs.
func TestTrafficSets_presetBatchIDs(t *testing.T) {
	seen := map[uint32]string{}
	byName := map[string]uint32{}
	for _, s := range trafficSets(trafficTable()) {
		if s.ID == 0 {
			t.Errorf("set %s has no preset ID", s.Name)
		}
		if other, dup := seen[s.ID]; dup {
			t.Errorf("sets %s and %s share ID %d", other, s.Name, s.ID)
		}
		seen[s.ID] = s.Name
		byName[s.Name] = s.ID
	}
	for chain, rules := range trafficRuleExprs(trafficBatchSetIDs) {
		for i, r := range rules {
			for _, l := range lookups(r) {
				if want, ok := byName[l.SetName]; !ok || l.SetID != want {
					t.Errorf("%s rule %d: lookup @%s uses ID %d, set has %d", chain, i, l.SetName, l.SetID, want)
				}
			}
		}
	}
}
