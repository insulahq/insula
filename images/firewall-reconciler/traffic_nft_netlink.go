// Netlink side of the traffic table (see traffic_nft.go for its shape).
//
// Uses its own nftables.Conn and mutex, independent of the firewall
// applier: a slow or failing traffic transaction can never hold up a
// firewall write. Every netlink socket gets a deadline, so a wedged kernel
// call fails (and backs off) instead of parking the traffic goroutine.

package main

import (
	"fmt"
	"sync"
	"time"

	"github.com/google/nftables"
	"github.com/mdlayher/netlink"
)

// newTrafficConn opens a (non-lasting) nftables Conn whose per-operation
// netlink sockets carry an nftTimeout deadline. Setting the deadline is
// best-effort: if a kernel refused it, the operation proceeds unbounded
// rather than failing outright.
func newTrafficConn() (*nftables.Conn, error) {
	return nftables.New(nftables.WithSockOptions(func(c *netlink.Conn) error {
		_ = c.SetDeadline(time.Now().Add(nftTimeout))
		return nil
	}))
}

// realTrafficNft is the netlink implementation of trafficNft.
type realTrafficNft struct {
	mu sync.Mutex
}

func newRealTrafficNft() *realTrafficNft { return &realTrafficNft{} }

func (t *realTrafficNft) ensure(d trafficDesired) (bool, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	conn, err := newTrafficConn()
	if err != nil {
		return false, fmt.Errorf("netlink open: %w", err)
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	table := trafficTable()
	exists, current, err := inspectTrafficTable(conn, table)
	if err != nil {
		return false, err
	}
	elems := trafficSetElements(d)
	if current {
		return false, refreshTrafficSets(conn, table, elems)
	}
	return true, recreateTrafficTable(conn, table, exists, elems)
}

// inspectTrafficTable reports whether the table exists and, if so, whether
// its structure is current.
func inspectTrafficTable(conn *nftables.Conn, table *nftables.Table) (exists, current bool, err error) {
	tables, err := conn.ListTablesOfFamily(nftables.TableFamilyINet)
	if err != nil {
		return false, false, fmt.Errorf("list inet tables: %w", err)
	}
	for _, tb := range tables {
		if tb.Name == trafficTableName {
			exists = true
			break
		}
	}
	if !exists {
		return false, false, nil
	}
	objs, err := conn.GetObjects(table)
	if err != nil {
		return true, false, fmt.Errorf("list %s objects: %w", trafficTableName, err)
	}
	names := make([]string, 0, len(objs))
	for _, o := range objs {
		if n, _, ok := counterNameValue(o); ok {
			names = append(names, n)
		}
	}
	chains, err := conn.ListChainsOfTableFamily(nftables.TableFamilyINet)
	if err != nil {
		return true, false, fmt.Errorf("list inet chains: %w", err)
	}
	ruleCounts := map[string]int{}
	for _, ch := range chains {
		if ch.Table == nil || ch.Table.Name != trafficTableName {
			continue
		}
		rules, err := conn.GetRules(table, ch)
		if err != nil {
			return true, false, fmt.Errorf("list %s/%s rules: %w", trafficTableName, ch.Name, err)
		}
		ruleCounts[ch.Name] = len(rules)
	}
	return true, trafficStructureCurrent(names, ruleCounts), nil
}

// refreshTrafficSets flushes + refills the five sets in one transaction, so
// the packet path never sees a half-filled set.
func refreshTrafficSets(conn *nftables.Conn, table *nftables.Table, elems map[string][]nftables.SetElement) error {
	sets, err := conn.GetSets(table)
	if err != nil {
		return fmt.Errorf("list %s sets: %w", trafficTableName, err)
	}
	byName := make(map[string]*nftables.Set, len(sets))
	for _, s := range sets {
		byName[s.Name] = s
	}
	for _, def := range trafficSets(table) {
		s, ok := byName[def.Name]
		if !ok {
			return fmt.Errorf("%s set %s vanished", trafficTableName, def.Name)
		}
		conn.FlushSet(s)
		if e := elems[def.Name]; len(e) > 0 {
			if err := conn.SetAddElements(s, e); err != nil {
				return fmt.Errorf("queue %s elements: %w", def.Name, err)
			}
		}
	}
	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit %s set refresh: %w", trafficTableName, err)
	}
	return nil
}

// recreateTrafficTable (re)builds the whole table in ONE transaction: the
// kernel applies the delete and the full rebuild atomically, so there is
// never a moment with base chains but no sets/counters behind them.
func recreateTrafficTable(conn *nftables.Conn, table *nftables.Table, exists bool, elems map[string][]nftables.SetElement) error {
	epoch, err := newTrafficEpoch()
	if err != nil {
		return err
	}
	if exists {
		conn.DelTable(table)
	}
	conn.AddTable(table)

	for _, s := range trafficSets(table) {
		if err := conn.AddSet(s, elems[s.Name]); err != nil {
			return fmt.Errorf("queue set %s: %w", s.Name, err)
		}
	}
	markers := []string{trafficSchemaMarker, trafficEpochPrefix + epoch}
	for _, name := range append(markers, trafficCounterNames()...) {
		conn.AddObj(&nftables.CounterObj{Table: table, Name: name})
	}

	pre, post, n2nIn, n2nOut := trafficChains(table)
	// Regular chains first so the base chains' jumps resolve.
	for _, ch := range []*nftables.Chain{n2nIn, n2nOut, pre, post} {
		conn.AddChain(ch)
	}
	exprs := trafficRuleExprs(trafficBatchSetIDs)
	for _, ch := range []*nftables.Chain{n2nIn, n2nOut, pre, post} {
		for _, e := range exprs[ch.Name] {
			conn.AddRule(&nftables.Rule{Table: table, Chain: ch, Exprs: e})
		}
	}
	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit %s table: %w", trafficTableName, err)
	}
	return nil
}

func (t *realTrafficNft) readCounters() (trafficReading, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	conn, err := newTrafficConn()
	if err != nil {
		return trafficReading{}, fmt.Errorf("netlink open: %w", err)
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	objs, err := conn.GetObjects(trafficTable())
	if err != nil {
		return trafficReading{}, fmt.Errorf("list %s objects: %w", trafficTableName, err)
	}
	return trafficReadingFromObjects(objs)
}
