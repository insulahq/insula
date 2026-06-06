package main

import (
	"context"
	"testing"
	"time"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
)

// ruleWith builds a *nftables.Rule with the given handle + expressions for
// the pure detection/anchor helpers (no kernel involved).
func ruleWith(handle uint64, exprs ...expr.Any) *nftables.Rule {
	return &nftables.Rule{Handle: handle, Exprs: exprs}
}

func lookupExpr(set string) expr.Any { return &expr.Lookup{SourceRegister: 1, SetName: set} }
func ctStateExpr() expr.Any          { return &expr.Ct{Key: expr.CtKeySTATE, Register: 1} }
func acceptExpr() expr.Any           { return &expr.Verdict{Kind: expr.VerdictAccept} }
func dropExpr() expr.Any             { return &expr.Verdict{Kind: expr.VerdictDrop} }

func TestRuleLooksUpSet(t *testing.T) {
	r := ruleWith(1, &expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1}, lookupExpr("blacklist_v4"), dropExpr())
	if !ruleLooksUpSet(r, "blacklist_v4") {
		t.Fatal("expected match on blacklist_v4")
	}
	if ruleLooksUpSet(r, "blacklist_v6") {
		t.Fatal("must not match a different set name")
	}
	if ruleLooksUpSet(ruleWith(2, ctStateExpr(), acceptExpr()), "blacklist_v4") {
		t.Fatal("ct-accept rule looks up no set")
	}
}

func TestRuleMatchesCtState(t *testing.T) {
	if !ruleMatchesCtState(ruleWith(1, ctStateExpr(), acceptExpr())) {
		t.Fatal("expected ct-state rule to match")
	}
	if ruleMatchesCtState(ruleWith(2, lookupExpr("crowdsec_blocklist_v4"), dropExpr())) {
		t.Fatal("crowdsec drop rule has no ct expr")
	}
}

func TestBlacklistDropRulePresent(t *testing.T) {
	chain := []*nftables.Rule{
		ruleWith(1, ctStateExpr(), acceptExpr()),
		ruleWith(2, lookupExpr("crowdsec_blocklist_v4"), dropExpr()),
		ruleWith(3, lookupExpr("blacklist_v4"), dropExpr()),
	}
	if !blacklistDropRulePresent(chain, "blacklist_v4") {
		t.Fatal("v4 drop rule should be detected present")
	}
	if blacklistDropRulePresent(chain, "blacklist_v6") {
		t.Fatal("v6 drop rule is absent — must report not present")
	}
}

func TestFindBlacklistDropAnchor(t *testing.T) {
	cases := []struct {
		name       string
		rules      []*nftables.Rule
		wantHandle uint64
		wantAfter  bool
		wantOK     bool
	}{
		{
			name: "established present → anchor after it (primary)",
			rules: []*nftables.Rule{
				ruleWith(10, ctStateExpr(), acceptExpr()),
				ruleWith(11, lookupExpr("crowdsec_blocklist_v4"), dropExpr()),
			},
			wantHandle: 10, wantAfter: true, wantOK: true,
		},
		{
			name: "no established, crowdsec present → anchor before crowdsec (fallback)",
			rules: []*nftables.Rule{
				ruleWith(20, lookupExpr(setCrowdsecV6), dropExpr()),
				ruleWith(21, lookupExpr(setBlacklistV4), dropExpr()),
			},
			wantHandle: 20, wantAfter: false, wantOK: true,
		},
		{
			name: "neither anchor → refuse",
			rules: []*nftables.Rule{
				ruleWith(30, &expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1}),
			},
			wantOK: false,
		},
		{
			name:   "empty chain → refuse",
			rules:  nil,
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, after, ok := findBlacklistDropAnchor(tc.rules)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if h != tc.wantHandle || after != tc.wantAfter {
				t.Fatalf("got (handle=%d after=%v), want (handle=%d after=%v)", h, after, tc.wantHandle, tc.wantAfter)
			}
		})
	}
}

func TestBuildBlacklistDropExprs_v4(t *testing.T) {
	exprs := buildBlacklistDropExprs("blacklist_v4", 7, false)
	if len(exprs) != 5 {
		t.Fatalf("expected 5 exprs, got %d", len(exprs))
	}
	meta, ok := exprs[0].(*expr.Meta)
	if !ok || meta.Key != expr.MetaKeyNFPROTO || meta.Register != 1 {
		t.Fatalf("expr[0] not meta-nfproto→reg1: %#v", exprs[0])
	}
	cmp, ok := exprs[1].(*expr.Cmp)
	if !ok || cmp.Op != expr.CmpOpEq || len(cmp.Data) != 1 || cmp.Data[0] != nfprotoIPv4 {
		t.Fatalf("expr[1] not cmp==NFPROTO_IPV4: %#v", exprs[1])
	}
	pl, ok := exprs[2].(*expr.Payload)
	if !ok || pl.Base != expr.PayloadBaseNetworkHeader || pl.Offset != ipv4SaddrOffset || pl.Len != ipv4SaddrLen || pl.DestRegister != 1 {
		t.Fatalf("expr[2] not ipv4 saddr payload load: %#v", exprs[2])
	}
	lu, ok := exprs[3].(*expr.Lookup)
	if !ok || lu.SetName != "blacklist_v4" || lu.SetID != 7 || lu.SourceRegister != 1 {
		t.Fatalf("expr[3] not lookup @blacklist_v4(id=7): %#v", exprs[3])
	}
	v, ok := exprs[4].(*expr.Verdict)
	if !ok || v.Kind != expr.VerdictDrop {
		t.Fatalf("expr[4] not verdict drop: %#v", exprs[4])
	}
}

func TestBuildBlacklistDropExprs_v6(t *testing.T) {
	exprs := buildBlacklistDropExprs("blacklist_v6", 9, true)
	cmp := exprs[1].(*expr.Cmp)
	if cmp.Data[0] != nfprotoIPv6 {
		t.Fatalf("v6 cmp must compare NFPROTO_IPV6 (0x0a), got 0x%02x", cmp.Data[0])
	}
	pl := exprs[2].(*expr.Payload)
	if pl.Offset != ipv6SaddrOffset || pl.Len != ipv6SaddrLen {
		t.Fatalf("v6 payload offset/len = %d/%d, want %d/%d", pl.Offset, pl.Len, ipv6SaddrOffset, ipv6SaddrLen)
	}
	if exprs[3].(*expr.Lookup).SetName != "blacklist_v6" {
		t.Fatalf("v6 lookup must reference blacklist_v6")
	}
}

// reconcileBlacklist must invoke the drop-rule self-heal every pass (after
// applying the sets), and surface its error.
func TestReconcileBlacklist_invokesEnsureDropRules(t *testing.T) {
	fa := &fakeApplier{}
	r := &reconciler{applier: fa}
	prot := buildBlacklistProtection(nil, nil, nil, nil, nil)

	if _, err := r.reconcileBlacklist(context.Background(), nil, prot, time.Now()); err != nil {
		t.Fatalf("reconcileBlacklist: %v", err)
	}
	if fa.ensureDropRulesCalls != 1 {
		t.Fatalf("ensureBlacklistDropRules called %d times, want 1", fa.ensureDropRulesCalls)
	}
}

func TestReconcileBlacklist_ensureDropRulesErrorPropagates(t *testing.T) {
	fa := &fakeApplier{ensureDropRulesErr: errReconcile}
	r := &reconciler{applier: fa}
	prot := buildBlacklistProtection(nil, nil, nil, nil, nil)

	_, err := r.reconcileBlacklist(context.Background(), nil, prot, time.Now())
	if err == nil {
		t.Fatal("expected reconcileBlacklist to surface the ensure-drop-rules error")
	}
}
