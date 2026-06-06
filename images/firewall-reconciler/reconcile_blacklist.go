package main

// Operator blacklist reconcile pass — folded into reconcileOnce.
//
// Reads ClusterFirewallBlacklist CRs, validates each spec.cidr, applies
// the SAME self-protect belt as the CrowdSec L4 reconciler (a ban that
// would drop a node IP / cluster peer / trusted range is REFUSED and the
// CR gets Ready=False), and writes the survivors into the nft
// `blacklist_v{4,6}` sets. Permanent — no TTL.

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// blacklistFingerprint mirrors peerFingerprint — canonical, order-stable.
func blacklistFingerprint(s blacklistNftSets) string {
	return strings.Join(s.V4, ",") + "|" + strings.Join(s.V6, ",")
}

func (r *reconciler) applyBlacklistIfChanged(s blacklistNftSets) (changed bool, err error) {
	want := blacklistFingerprint(s)
	have, obsErr := r.applier.observeBlacklistFingerprint()
	if obsErr == nil && have == want {
		return false, nil
	}
	if err := r.applier.applyBlacklist(s); err != nil {
		return false, err
	}
	return true, nil
}

// blacklistProtection is the exclusion set the blacklist must not catch.
// Built from values reconcileOnce already computed, so no extra API reads.
type blacklistProtection struct {
	prefixes []netip.Prefix
}

func buildBlacklistProtection(nodeIPs, peerV4, peerV6, trustedV4, trustedV6 []string) blacklistProtection {
	var p blacklistProtection
	add := func(canon string) {
		// canon may be a bare IP (node/peer) or a CIDR (trusted). Parse both.
		if pre, err := netip.ParsePrefix(canon); err == nil {
			p.prefixes = append(p.prefixes, unmapPrefix(pre))
			return
		}
		if addr, err := netip.ParseAddr(canon); err == nil {
			p.prefixes = append(p.prefixes, netip.PrefixFrom(addr.Unmap(), addr.BitLen()))
		}
	}
	for _, ip := range nodeIPs {
		add(ip)
	}
	for _, ip := range peerV4 {
		add(ip)
	}
	for _, ip := range peerV6 {
		add(ip)
	}
	for _, c := range trustedV4 {
		add(c)
	}
	for _, c := range trustedV6 {
		add(c)
	}
	return p
}

// intersects reports whether the proposed ban overlaps any protected
// prefix in EITHER direction (proposed contains protected, or protected
// contains proposed). Either way enforcing the ban would cut protected
// access.
func (p blacklistProtection) intersects(proposed netip.Prefix) (netip.Prefix, bool) {
	proposed = unmapPrefix(proposed)
	for _, ex := range p.prefixes {
		if prefixContainsOrEquals(proposed, ex) || prefixContainsOrEquals(ex, proposed) {
			return ex, true
		}
	}
	return netip.Prefix{}, false
}

// reconcileBlacklist computes + applies the blacklist sets and patches
// each CFB's status. Best-effort status patches (kube-API hiccup on one
// CR does not roll back the firewall). Returns the applied set for logging.
func (r *reconciler) reconcileBlacklist(
	ctx context.Context,
	cfbObjs []runtime.Object,
	prot blacklistProtection,
	now time.Time,
) (blacklistNftSets, error) {
	v4, v6 := []string{}, []string{}

	for _, obj := range cfbObjs {
		cfb, ok := asUnstructured(obj)
		if !ok {
			continue
		}
		spec, ok := readCFBSpec(cfb)
		if !ok {
			r.patchCFBStatus(ctx, cfb, "", "", now, condition{
				Type: "Ready", Status: "False", Reason: "InvalidSpec",
				Message: "spec.cidr is empty", Time: now,
			})
			continue
		}
		canonical, family, ok := parseIPOrCIDR(spec.Cidr)
		if !ok {
			r.patchCFBStatus(ctx, cfb, "", "", now, condition{
				Type: "Ready", Status: "False", Reason: "InvalidCidr",
				Message: fmt.Sprintf("%q rejected by net/netip", spec.Cidr), Time: now,
			})
			continue
		}
		pre, err := netip.ParsePrefix(canonical)
		if err != nil {
			r.patchCFBStatus(ctx, cfb, "", "", now, condition{
				Type: "Ready", Status: "False", Reason: "InvalidCidr",
				Message: err.Error(), Time: now,
			})
			continue
		}
		// SELF-PROTECT: refuse a ban that would drop protected space.
		if hit, bad := prot.intersects(pre); bad {
			r.patchCFBStatus(ctx, cfb, canonical, family, now, condition{
				Type: "Ready", Status: "False", Reason: "SelfProtect",
				Message: fmt.Sprintf("refused — overlaps protected %s (node IP / peer / trusted range)", hit.String()),
				Time:    now,
			})
			continue
		}
		if family == "v4" {
			v4 = append(v4, canonical)
		} else {
			v6 = append(v6, canonical)
		}
		r.patchCFBStatus(ctx, cfb, canonical, family, now, condition{
			Type: "Ready", Status: "True", Reason: "Enforced",
			Message: "dropping on all ports", Time: now,
		})
	}

	desired := blacklistNftSets{V4: uniqueSorted(v4), V6: uniqueSorted(v6)}
	changed, err := r.applyBlacklistIfChanged(desired)
	if err != nil {
		return desired, fmt.Errorf("apply blacklist nft: %w", err)
	}
	if changed {
		slog.Info("blacklist nft sets reconciled", "v4", len(desired.V4), "v6", len(desired.V6))
	}
	return desired, nil
}

func (r *reconciler) patchCFBStatus(
	ctx context.Context,
	cfb *unstructured.Unstructured,
	normalizedCidr, family string,
	now time.Time,
	cond condition,
) {
	r.writeStatus(ctx, r.cfbClient, cfb, statusPayload{
		ObservedGeneration: cfb.GetGeneration(),
		NormalizedCidr:     normalizedCidr,
		Family:             family,
		LastSyncedAt:       now,
		Conditions:         []condition{cond},
	})
}
