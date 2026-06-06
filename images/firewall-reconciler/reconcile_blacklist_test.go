package main

import (
	"net/netip"
	"testing"
)

func mustPrefixBL(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return p
}

func TestBlacklistFingerprint(t *testing.T) {
	a := blacklistFingerprint(blacklistNftSets{V4: []string{"1.2.3.0/24", "5.6.7.8/32"}, V6: []string{"fd00::/8"}})
	b := blacklistFingerprint(blacklistNftSets{V4: []string{"1.2.3.0/24", "5.6.7.8/32"}, V6: []string{"fd00::/8"}})
	if a != b {
		t.Fatal("same input must produce same fingerprint")
	}
	if a == blacklistFingerprint(blacklistNftSets{V4: []string{"1.2.3.0/24"}, V6: []string{"fd00::/8"}}) {
		t.Fatal("different input must differ")
	}
}

func TestBuildBlacklistProtectionAndIntersect(t *testing.T) {
	// node internal IPs (bare), pending-peer IPs (bare), trusted CIDRs.
	prot := buildBlacklistProtection(
		[]string{"10.0.0.5", "2001:db8::5"}, // node IPs
		[]string{"203.0.113.7"},             // peers v4
		[]string{"2001:db8:a::7"},           // peers v6
		[]string{"192.0.2.0/24"},            // trusted v4
		[]string{"fd00::/16"},               // trusted v6
	)

	cases := []struct {
		name        string
		cidr        string
		wantBlocked bool
	}{
		{"hostile single v4 — allowed", "45.148.10.240/32", false},
		{"hostile v4 /24 touching nothing — allowed", "45.148.10.0/24", false},
		{"equals a node IP — blocked", "10.0.0.5/32", true},
		{"contains a node IP — blocked", "10.0.0.0/16", true},
		{"equals a peer — blocked", "203.0.113.7/32", true},
		{"inside a trusted range — blocked", "192.0.2.50/32", true},
		{"contains a trusted range — blocked", "192.0.0.0/8", true},
		{"hostile v6 — allowed", "2600:abcd::/32", false},
		{"equals v6 node IP — blocked", "2001:db8::5/128", true},
		{"inside v6 trusted — blocked", "fd00:1234::/32", true},
		{"v4 ban never matches v6 protected", "8.8.8.0/24", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, blocked := prot.intersects(mustPrefixBL(t, tc.cidr))
			if blocked != tc.wantBlocked {
				t.Fatalf("intersects(%s) = %v, want %v", tc.cidr, blocked, tc.wantBlocked)
			}
		})
	}
}

func TestBlacklistProtectionEmpty(t *testing.T) {
	// No protected space → nothing is blocked (fresh cluster, no peers).
	prot := buildBlacklistProtection(nil, nil, nil, nil, nil)
	if _, blocked := prot.intersects(mustPrefixBL(t, "45.148.10.0/24")); blocked {
		t.Fatal("empty protection must block nothing")
	}
}

// Regression: deleting the last CFB (desired empty) must STILL apply
// (flush) the nft set — the old observe-diff skipped this, leaving
// unbanned IPs stuck in the kernel. applyBlacklistOnce always applies.
func TestApplyBlacklistOnce_alwaysApplies(t *testing.T) {
	fa := &fakeApplier{}
	r := &reconciler{applier: fa}

	// First apply: one ban.
	if _, err := r.applyBlacklistOnce(blacklistNftSets{V4: []string{"45.148.10.240/32"}}); err != nil {
		t.Fatal(err)
	}
	// Second apply: SAME desired → still applies (idempotent flush+add),
	// but reports changed=false (no log spam).
	changed, err := r.applyBlacklistOnce(blacklistNftSets{V4: []string{"45.148.10.240/32"}})
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("re-applying identical desired must report changed=false")
	}
	// Third apply: EMPTY desired (last CFB deleted) → MUST apply the
	// flush so the kernel set clears, and report changed=true.
	changed, err = r.applyBlacklistOnce(blacklistNftSets{})
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("clearing to empty must report changed=true")
	}
	if len(fa.blacklistCalls) != 3 {
		t.Fatalf("expected 3 applies (always-apply), got %d", len(fa.blacklistCalls))
	}
	last := fa.blacklistCalls[2]
	if len(last.V4) != 0 || len(last.V6) != 0 {
		t.Fatalf("final apply must be empty (flush), got v4=%v v6=%v", last.V4, last.V6)
	}
}
