package main

// Operator-blacklist DROP-RULE self-heal — Tier 2 / Phase C.
//
// The reconciler already converges blacklist set MEMBERSHIP
// (reconcile_blacklist.go + nft_blacklist.go). But the nft rule that makes
// membership matter — `ip saddr @blacklist_v4 drop` — is rendered by
// bootstrap.sh into /etc/nftables.conf and is therefore present ONLY on
// clusters bootstrapped after the blacklist feature shipped (PR #194). On
// a cluster bootstrapped earlier the reconciler creates + populates the
// blacklist_v{4,6} sets, but with no drop rule referencing them the bans
// never take effect.
//
// That existing-cluster gap was previously closed by a one-shot
// host-migration (platform/host-migrations/2026.6.3/0001-firewall-
// blacklist-nft.sh). This pass makes the reconciler ensure the drop rule
// itself on every tick, so existing clusters self-heal exactly like the
// sysctl/host-config convergers — no one-shot migration to author or run,
// and the rule re-asserts automatically after an out-of-band
// `nft flush ruleset` or a reboot (which reloads the migration-less conf).
//
// NO /etc/nftables.conf edit — same model as set membership. After a
// reboot the rule is briefly absent until the next reconcile re-inserts
// it, but the SET is also empty until the reconcile repopulates it, so
// there is nothing to drop in that window. New clusters render the rule
// from bootstrap conf, so this pass is a harmless no-op there.
//
// Ordering (F7): the drop MUST sit AFTER `ct state established,related
// accept` (so an operator who bans their own IP keeps the in-flight
// session) and BEFORE any port accept (so a banned IP reaches nothing).
// We anchor on the established-accept rule and insert immediately AFTER
// it; if that rule cannot be located we fall back to inserting BEFORE the
// crowdsec drop rule (bootstrap renders it right after established-accept,
// so before-crowdsec is still inside the F7 window). If NEITHER anchor is
// found we refuse to insert and log a warning, rather than risk placing
// the rule in a wrong position.

import (
	"fmt"
	"log/slog"

	"github.com/google/nftables"
	"github.com/google/nftables/expr"
)

const inputChainName = "input"

// Source-address payload offsets inside the IP network header.
// IPv4 saddr = bytes 12..15 (len 4); IPv6 saddr = bytes 8..23 (len 16).
const (
	ipv4SaddrOffset = 12
	ipv4SaddrLen    = 4
	ipv6SaddrOffset = 8
	ipv6SaddrLen    = 16
)

// NFPROTO_* — netfilter L3 protocol selectors (include/uapi/linux/
// netfilter.h). Stable kernel ABI; defined locally to keep the reconciler
// free of a direct golang.org/x/sys/unix dependency (matches the rest of
// nft.go, which uses only library-provided typed constants).
const (
	nfprotoIPv4 = 0x02
	nfprotoIPv6 = 0x0a
)

// ensureBlacklistDropRules makes the input chain contain the
// `<l3> saddr @blacklist_v{4,6} drop` rules, inserting any that are
// missing in the F7-correct position. Idempotent: a no-op once both are
// present. MUST run AFTER applyBlacklist, which guarantees the sets the
// rules reference already exist.
func (r *realApplier) ensureBlacklistDropRules() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	inputChain := &nftables.Chain{Name: inputChainName, Table: table}
	rules, err := conn.GetRules(table, inputChain)
	if err != nil {
		return fmt.Errorf("list %s chain rules: %w", inputChainName, err)
	}

	haveV4 := blacklistDropRulePresent(rules, setBlacklistV4)
	haveV6 := blacklistDropRulePresent(rules, setBlacklistV6)
	if haveV4 && haveV6 {
		return nil // already converged — the common steady-state path
	}

	anchor, after, ok := findBlacklistDropAnchor(rules)
	if !ok {
		slog.Warn("blacklist drop-rule self-heal skipped: no safe anchor in input chain " +
			"(neither ct-established-accept nor a crowdsec drop found) — " +
			"bootstrap or the host-migration will place the rule")
		return nil
	}

	// Build + queue the missing rule(s). The set must exist (applyBlacklist
	// ensures it); fetch its kernel ID so the Lookup resolves the exact
	// committed set rather than relying on name-only resolution.
	queue := func(name string, isV6 bool) error {
		set, err := conn.GetSetByName(table, name)
		if err != nil {
			return fmt.Errorf("lookup set %s for drop rule: %w", name, err)
		}
		rule := &nftables.Rule{
			Table:    table,
			Chain:    inputChain,
			Position: anchor,
			Exprs:    buildBlacklistDropExprs(set.Name, set.ID, isV6),
		}
		if after {
			conn.AddRule(rule) // Position + APPEND → insert AFTER anchor
		} else {
			conn.InsertRule(rule) // Position, no APPEND → insert BEFORE anchor
		}
		return nil
	}

	// When BOTH rules are missing, the queue order is chosen so the resulting
	// chain lists v4 before v6 (bootstrap.sh's canonical order), so `nft list`
	// is identical on self-healed and freshly-bootstrapped clusters:
	//   after=true  (AddRule after anchor): each insert lands immediately
	//               after the anchor, pushing earlier inserts down → queue v6
	//               first so v4 ends up first.
	//   after=false (InsertRule before anchor): each insert lands immediately
	//               before the anchor, after earlier inserts → queue v4 first.
	// The order is functionally irrelevant — the nfproto guard makes the v4
	// and v6 rules mutually exclusive — this is purely for output parity.
	todo := make([]struct {
		name string
		isV6 bool
	}, 0, 2)
	if !haveV4 {
		todo = append(todo, struct {
			name string
			isV6 bool
		}{setBlacklistV4, false})
	}
	if !haveV6 {
		todo = append(todo, struct {
			name string
			isV6 bool
		}{setBlacklistV6, true})
	}
	if after { // reverse so the after-anchor inserts settle into v4-before-v6
		for i, j := 0, len(todo)-1; i < j; i, j = i+1, j-1 {
			todo[i], todo[j] = todo[j], todo[i]
		}
	}
	for _, t := range todo {
		if err := queue(t.name, t.isV6); err != nil {
			return err
		}
	}

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("insert blacklist drop rule(s): %w", err)
	}
	slog.Info("blacklist drop-rule self-healed",
		"v4_inserted", !haveV4, "v6_inserted", !haveV6, "anchor_after", after)
	return nil
}

// buildBlacklistDropExprs constructs the netlink expression list for
// `<l3> saddr @<set> drop` in an inet-family chain:
//
//	meta load nfproto => reg1 ; cmp reg1 == <nfproto>
//	payload load saddr => reg1 ; lookup reg1 @<set> ; verdict drop
//
// The leading nfproto guard is what `nft` emits for an `ip`/`ip6` saddr
// match inside an inet table, and is required so the IPv4 rule never reads
// past a v6 header (and vice-versa).
func buildBlacklistDropExprs(setName string, setID uint32, isV6 bool) []expr.Any {
	nfproto := byte(nfprotoIPv4)
	offset, length := uint32(ipv4SaddrOffset), uint32(ipv4SaddrLen)
	if isV6 {
		nfproto = byte(nfprotoIPv6)
		offset, length = uint32(ipv6SaddrOffset), uint32(ipv6SaddrLen)
	}
	return []expr.Any{
		&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{nfproto}},
		&expr.Payload{
			DestRegister: 1,
			Base:         expr.PayloadBaseNetworkHeader,
			Offset:       offset,
			Len:          length,
		},
		&expr.Lookup{SourceRegister: 1, SetName: setName, SetID: setID},
		&expr.Verdict{Kind: expr.VerdictDrop},
	}
}

// blacklistDropRulePresent reports whether the input chain already has a
// rule that looks up `setName`.
//
// The set-name reference is a sufficient discriminator: only the blacklist
// drop rule references blacklist_v{4,6}. The verdict is deliberately NOT
// checked — on the netlink READ path google/nftables decodes a verdict as
// an Immediate whose verdict kind it does not populate, so drop-vs-accept
// is not recoverable from a parsed rule. The unique set reference is.
//
// Matching by set reference alone (rather than the full expression tree) is
// the SAFE choice: it is robust to benign encoding differences between the
// bootstrap-rendered, host-migration-inserted, and reconciler-inserted forms
// of the rule, so the reconciler never inserts a DUPLICATE every tick (which
// would be unbounded chain growth — the worse failure). The assumption is
// that whatever already references the set is a well-formed, nfproto-guarded
// `<l3> saddr @blacklist_vN drop` — true for all three writers above. A
// hand-crafted unguarded rule inserted out-of-band is out of scope (and not
// reachable via `nft`, which always compiles the nfproto guard for an
// `ip`/`ip6 saddr` match in an inet table).
func blacklistDropRulePresent(rules []*nftables.Rule, setName string) bool {
	for _, rule := range rules {
		if ruleLooksUpSet(rule, setName) {
			return true
		}
	}
	return false
}

// ruleLooksUpSet reports whether any expression in the rule is a set
// lookup against setName.
func ruleLooksUpSet(rule *nftables.Rule, setName string) bool {
	for _, e := range rule.Exprs {
		if lu, ok := e.(*expr.Lookup); ok && lu.SetName == setName {
			return true
		}
	}
	return false
}

// ruleMatchesCtState reports whether the rule matches on conntrack state —
// uniquely the `ct state established,related accept` rule in our input
// chain (no other rule there carries a ct expression; Calico/kube-proxy
// ct rules live in different tables and are not returned by GetRules on
// inet filter input).
func ruleMatchesCtState(rule *nftables.Rule) bool {
	for _, e := range rule.Exprs {
		if ct, ok := e.(*expr.Ct); ok && ct.Key == expr.CtKeySTATE {
			return true
		}
	}
	return false
}

// findBlacklistDropAnchor returns the rule handle to position the blacklist
// drop against, and whether to insert AFTER (true) or BEFORE (false) it.
//
//	Primary  — the ct-established-accept rule: insert AFTER. This is the
//	           F7 anchor by definition and present in every cluster.
//	Fallback — the crowdsec drop rule (bootstrap renders it immediately
//	           after established-accept): insert BEFORE, still inside the
//	           F7 window (after established, before the port accepts).
//
// ok=false means no safe anchor was found; the caller then refuses to
// insert rather than guess a position.
func findBlacklistDropAnchor(rules []*nftables.Rule) (handle uint64, after, ok bool) {
	for _, rule := range rules {
		if ruleMatchesCtState(rule) {
			return rule.Handle, true, true
		}
	}
	for _, rule := range rules {
		if ruleLooksUpSet(rule, setCrowdsecV4) || ruleLooksUpSet(rule, setCrowdsecV6) {
			return rule.Handle, false, true
		}
	}
	return 0, false, false
}
