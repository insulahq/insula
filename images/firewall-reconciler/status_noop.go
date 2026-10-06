// Status-write no-op detection for the CRD status writers.
//
// Every node's peer loop computes the same status for every CTR / CPP / CFB
// and used to PATCH it unconditionally on every reconcile with a fresh
// lastSyncedAt and condition time. That made each patch a real change, each
// change an informer Update on all nodes, and each Update a new reconcile —
// a self-sustaining PATCH loop across the cluster. Two halves stop it:
//
//   - here: skip the PATCH when the CR already carries the computed status
//     (timestamps aside) and its lastSyncedAt is still fresh, and keep a
//     condition's lastTransitionTime when nothing about it changed;
//   - informer_filters.go: status-only Updates no longer kick a reconcile.
//
// lastSyncedAt is still refreshed — the admin UI shows it for trusted
// ranges and blacklists — just at statusRefreshInterval, not every tick.

package main

import (
	"encoding/json"
	"reflect"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// statusRefreshInterval bounds how old status.lastSyncedAt may get before an
// otherwise-unchanged status is written again.
const statusRefreshInterval = 5 * time.Minute

const (
	statusKeyLastSyncedAt = "lastSyncedAt"
	statusKeyConditions   = "conditions"
	condKeyTransitionTime = "lastTransitionTime"
)

// existingStatus returns the CR's current .status (as last seen by the
// informer), or nil when it has none. Read-only: the map belongs to the
// lister cache and must not be mutated.
func existingStatus(cr *unstructured.Unstructured) map[string]any {
	if cr == nil {
		return nil
	}
	raw, found, err := unstructured.NestedFieldNoCopy(cr.Object, "status")
	if err != nil || !found {
		return nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

// existingConditions returns status.conditions as a list of maps, skipping
// any element that is not an object.
func existingConditions(status map[string]any) []map[string]any {
	raw, ok := status[statusKeyConditions].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, c := range raw {
		if m, ok := c.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// carriedTransitionTime returns the previous lastTransitionTime for a
// condition whose type, status, reason and message are all unchanged — so a
// rewrite (for a stale lastSyncedAt) does not move the condition's time.
func carriedTransitionTime(prev []map[string]any, c condition) (string, bool) {
	for _, old := range prev {
		if old["type"] != c.Type {
			continue
		}
		if old["status"] != c.Status || old["reason"] != c.Reason || old["message"] != c.Message {
			return "", false
		}
		ts, ok := old[condKeyTransitionTime].(string)
		return ts, ok && ts != ""
	}
	return "", false
}

// statusPatchIsNoop reports whether merge-patching `desired` onto `existing`
// would change nothing a reader cares about, so the PATCH can be skipped.
//
// It compares only the keys the patch would write (a JSON merge patch leaves
// every other key alone), ignoring lastSyncedAt and each condition's
// lastTransitionTime. When the patch carries a lastSyncedAt, the existing one
// must also be younger than statusRefreshInterval relative to syncedAt —
// otherwise the write goes through to refresh it.
func statusPatchIsNoop(existing, desired map[string]any, syncedAt time.Time) bool {
	if existing == nil {
		return false
	}
	ex, ok1 := normalizeJSON(existing).(map[string]any)
	de, ok2 := normalizeJSON(desired).(map[string]any)
	if !ok1 || !ok2 {
		return false
	}
	for key, want := range de {
		if key == statusKeyLastSyncedAt {
			continue
		}
		got, present := ex[key]
		if !present {
			return false
		}
		if key == statusKeyConditions {
			if !conditionsEqualIgnoringTime(got, want) {
				return false
			}
			continue
		}
		if !reflect.DeepEqual(got, want) {
			return false
		}
	}
	if _, wantsSync := de[statusKeyLastSyncedAt]; wantsSync {
		return lastSyncedFresh(ex[statusKeyLastSyncedAt], syncedAt)
	}
	return true
}

// conditionsEqualIgnoringTime compares two normalized condition lists
// element by element (order matters — a merge patch replaces the whole
// array), with lastTransitionTime excluded from each element.
func conditionsEqualIgnoringTime(got, want any) bool {
	g, ok1 := got.([]any)
	w, ok2 := want.([]any)
	if !ok1 || !ok2 || len(g) != len(w) {
		return false
	}
	for i := range g {
		gm, ok1 := g[i].(map[string]any)
		wm, ok2 := w[i].(map[string]any)
		if !ok1 || !ok2 {
			return false
		}
		if !reflect.DeepEqual(withoutKey(gm, condKeyTransitionTime), withoutKey(wm, condKeyTransitionTime)) {
			return false
		}
	}
	return true
}

// lastSyncedFresh reports whether an existing lastSyncedAt value is a
// parseable timestamp within statusRefreshInterval of now, in either
// direction (a few seconds of clock skew between nodes is normal; a value
// far in the future is not trusted and gets rewritten).
func lastSyncedFresh(raw any, now time.Time) bool {
	s, ok := raw.(string)
	if !ok || s == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return false
	}
	age := now.Sub(t)
	return age < statusRefreshInterval && age > -statusRefreshInterval
}

// withoutKey returns a shallow copy of m without key.
func withoutKey(m map[string]any, key string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if k != key {
			out[k] = v
		}
	}
	return out
}

// normalizeJSON round-trips v through encoding/json so values built in Go
// (int64, []map[string]any) and values decoded by the informer (int64 or
// float64, []any) compare equal when they serialize identically. A value
// that cannot be marshalled normalizes to nil, which never matches a map.
func normalizeJSON(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}
	return out
}
