package main

// Operator blacklist nft sets — `blacklist_v4` / `blacklist_v6`.
//
// Shape is identical to trusted_ranges (interval CIDR sets, no timeout)
// but the bootstrap-declared rule DROPs members instead of accepting.
// Permanent: unlike crowdsec_blocklist these carry no per-element TTL.
// Reconcile order places the DROP after `ct state established,related
// accept` (so an operator who bans their own IP keeps the in-flight
// session) and before any port accept (so a banned IP reaches nothing).

import "fmt"

const (
	setBlacklistV4 = "blacklist_v4"
	setBlacklistV6 = "blacklist_v6"
)

// blacklistNftSets — what the blacklist reconcile pass writes. CIDRs are
// canonical (network address + prefix) as produced by parseIPOrCIDR.
type blacklistNftSets struct {
	V4 []string
	V6 []string
}

// applyBlacklist writes the v4 + v6 blacklist sets via one batched
// netlink transaction — same two-phase commit as applyPeerSets, reusing
// ensureAddrSet (interval, no timeout) + cidrsToElements.
func (r *realApplier) applyBlacklist(s blacklistNftSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensureAddrSet(conn, table, setBlacklistV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setBlacklistV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit blacklist set creations: %w", err)
		}
	}

	v4Set, err := conn.GetSetByName(table, setBlacklistV4)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setBlacklistV4, err)
	}
	v6Set, err := conn.GetSetByName(table, setBlacklistV6)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setBlacklistV6, err)
	}

	r.flushAndAddElements(conn, v4Set, cidrsToElements(s.V4, false))
	r.flushAndAddElements(conn, v6Set, cidrsToElements(s.V6, true))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit blacklist member updates: %w", err)
	}
	return nil
}
