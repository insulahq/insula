package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadMigrationStatusAbsentIsNotAnError(t *testing.T) {
	// A node that has never converged is normal — a fresh install, or the policy
	// is observe. Reporting that as an error would cry wolf on every new node.
	st, errs := readMigrationStatus(filepath.Join(t.TempDir(), "nope.json"))
	if st != nil || len(errs) != 0 {
		t.Fatalf("absent status should be (nil, nil); got %v / %v", st, errs)
	}
}

func TestReadMigrationStatusMalformedReportsRatherThanPanics(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, errs := readMigrationStatus(p)
	if st != nil || len(errs) != 1 {
		t.Fatalf("malformed status should surface one error; got %v / %v", st, errs)
	}
}

func TestReadMigrationStatusDerivesCounts(t *testing.T) {
	// The counts are derived once, here, so the API and UI cannot disagree with
	// each other by re-deriving them differently.
	p := filepath.Join(t.TempDir(), "status.json")
	body := `{"schema":1,"mode":"enforce","source":"embedded","ok":false,"appliedCount":2,"items":[
	  {"key":"2026.7.1/0001-a.sh","state":"run-failed","error":"boom","attempt":840,"failingSince":"2026-07-01"},
	  {"key":"2026.7.1/0002-b.sh","state":"blocked"},
	  {"key":"2026.7.1/0003-c.sh","state":"blocked"},
	  {"key":"2026.8.1/0001-d.sh","state":"skipped","skipReason":"stale values"},
	  {"key":"2026.8.2/0001-e.sh","state":"would-run"}]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, errs := readMigrationStatus(p)
	if len(errs) != 0 || st == nil {
		t.Fatalf("unexpected: %v / %v", st, errs)
	}
	if st.FailedCount != 1 || st.BlockedCount != 2 || st.SkippedCount != 1 || st.PendingCount != 1 {
		t.Fatalf("counts wrong: failed=%d blocked=%d skipped=%d pending=%d",
			st.FailedCount, st.BlockedCount, st.SkippedCount, st.PendingCount)
	}
	if st.Items[0].Attempt == nil || *st.Items[0].Attempt != 840 {
		t.Fatal("attempt count must survive the relay — it is what makes a wedge legible")
	}
	if st.Items[0].FailingSince == nil || *st.Items[0].FailingSince != "2026-07-01" {
		t.Fatal("failingSince must survive the relay")
	}
}

// A migration's stderr is captured verbatim on failure, and the whole Snapshot
// goes into ONE ConfigMap key that etcd caps at ~1 MiB. Uncapped, a noisy
// failure would make publish() fail outright and freeze this node's reporting
// at its last-known state — at exactly the moment the panel matters most.
func TestReadMigrationStatusCapsHostileFields(t *testing.T) {
	huge := strings.Repeat("x", 50_000)
	path := writeStatus(t, MigrationStatus{
		AppliedCount: 2,
		Items: []MigrationItem{
			{Key: "v/0001.sh", State: "run-failed", Error: &huge},
			{Key: "v/0002.sh", State: "skipped", SkipReason: &huge},
		},
	})
	st, errs := readMigrationStatus(path)
	if len(errs) != 0 || st == nil {
		t.Fatalf("expected a relayed status, got errs=%v st=%v", errs, st)
	}
	if got := len(*st.Items[0].Error); got > maxMigrationField+32 {
		t.Errorf("error field not clipped: %d bytes", got)
	}
	if got := len(*st.Items[1].SkipReason); got > maxMigrationField+32 {
		t.Errorf("skipReason not clipped: %d bytes", got)
	}
	if st.FailedCount != 1 || st.SkippedCount != 1 {
		t.Errorf("counts wrong after clipping: failed=%d skipped=%d", st.FailedCount, st.SkippedCount)
	}
	if st.AppliedCount != 2 {
		t.Errorf("appliedCount not relayed: got %d", st.AppliedCount)
	}
}

// Truncation must never cost us a failure. Applied items are summarised by
// appliedCount and hidden by the panel anyway, so they are dropped first.
func TestCapItemsKeepsEveryFailureAndDropsAppliedFirst(t *testing.T) {
	items := make([]MigrationItem, 0, maxMigrationItems+50)
	for i := 0; i < maxMigrationItems+40; i++ {
		items = append(items, MigrationItem{Key: "applied.sh", State: "already-applied"})
	}
	items = append(items,
		MigrationItem{Key: "boom.sh", State: "run-failed"},
		MigrationItem{Key: "queued.sh", State: "blocked"},
	)
	out, truncated := capItems(items)
	if !truncated {
		t.Fatal("expected truncation")
	}
	if len(out) > maxMigrationItems {
		t.Errorf("cap not honoured: %d items", len(out))
	}
	var failed, blocked int
	for _, it := range out {
		switch it.State {
		case "run-failed":
			failed++
		case "blocked":
			blocked++
		}
	}
	if failed != 1 || blocked != 1 {
		t.Errorf("truncation dropped the items that matter: failed=%d blocked=%d", failed, blocked)
	}
}

func TestReadMigrationStatusRejectsAnOversizedFile(t *testing.T) {
	// Deliberately VALID JSON. Random bytes would be rejected by the JSON parser
	// no matter what, so such a test would pass with the size ceiling removed —
	// it would prove nothing. This document parses fine; only the ceiling can
	// stop it, and we assert on that specific refusal.
	big := make([]MigrationItem, 0, 4000)
	pad := strings.Repeat("y", 300)
	for i := 0; i < 4000; i++ {
		e := pad
		big = append(big, MigrationItem{Key: "v/000" + strings.Repeat("1", 20) + ".sh", State: "applied", Error: &e})
	}
	path := writeStatus(t, MigrationStatus{Items: big})
	if fi, err := os.Stat(path); err != nil || fi.Size() <= maxStatusFileBytes {
		t.Fatalf("fixture is not actually oversized (%v)", err)
	}

	st, errs := readMigrationStatus(path)
	if st != nil {
		t.Fatalf("oversized file must not be relayed, got %d items", len(st.Items))
	}
	if len(errs) != 1 || !strings.Contains(errs[0], "too large") {
		t.Fatalf("expected the size refusal, got %v", errs)
	}
}

// The relay is wired into collect() even when there is no host-config-desired
// ConfigMap: a node with no desired sysctls can still have a broken chain, and
// that is exactly the case worth surfacing.
func TestCollectRelaysMigrationsWithNoDesiredConfig(t *testing.T) {
	boom := "schema rejects runtimeClassName"
	path := writeStatus(t, MigrationStatus{
		Items: []MigrationItem{{Key: "v/0001.sh", State: "run-failed", Error: &boom}},
	})
	c := &collector{hostRoot: t.TempDir(), nodeName: "n1", now: fixedNow, allow: sysctlAllowed, migrationStatusPath: path}

	snap := c.collect(nil)

	if snap.DesiredSource != "absent" {
		t.Errorf("expected absent desired, got %q", snap.DesiredSource)
	}
	if snap.HostMigrations == nil {
		t.Fatal("host-migration state was not relayed when desired config is absent")
	}
	if snap.HostMigrations.FailedCount != 1 {
		t.Errorf("failed count = %d, want 1", snap.HostMigrations.FailedCount)
	}
}

func writeStatus(t *testing.T, st MigrationStatus) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "status.json")
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// ADR-056 §5: a `.baseline` item ("a fresh bootstrap already reflects this; it
// never ran here") must reach the API. The relay unmarshals into a typed
// struct, so a field missing here is silently DROPPED and the panel could not
// tell a baselined node from one where every migration really ran.
func TestReadMigrationStatusRelaysBaseline(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	body := `{"schema":1,"mode":"enforce","source":"embedded","ok":true,"appliedCount":0,"items":[
	  {"key":"2026.6.3/0001-a.sh","state":"already-applied","baseline":true},
	  {"key":"2026.6.3/0002-b.sh","state":"already-applied","baseline":null}]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, errs := readMigrationStatus(p)
	if len(errs) != 0 || st == nil {
		t.Fatalf("unexpected: %v / %v", st, errs)
	}
	if st.Items[0].Baseline == nil || !*st.Items[0].Baseline {
		t.Fatal("baseline:true must survive the relay")
	}
	if st.Items[1].Baseline != nil {
		t.Fatal("a null baseline must stay absent")
	}
	out, err := json.Marshal(st.Items[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "baseline") {
		t.Fatalf("an absent baseline must be omitted from the relayed item, got %s", out)
	}
}

func TestReadMigrationStatusRelaysCliVersion(t *testing.T) {
	// The node CLI's version is what tells a node that has not fetched the new
	// release apart from one that has — both report "nothing pending". Dropping it
	// here (the struct, not the file, decides what travels) silently restores the
	// false green this field exists to end.
	p := filepath.Join(t.TempDir(), "status.json")
	body := `{"schema":1,"cliVersion":"2026.10.7-rc.2","mode":"enforce","source":"embedded","ok":true,"appliedCount":0,"items":[]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, errs := readMigrationStatus(p)
	if len(errs) != 0 || st == nil {
		t.Fatalf("unexpected: %v / %v", st, errs)
	}
	if st.CliVersion != "2026.10.7-rc.2" {
		t.Fatalf("cliVersion must be relayed; got %q", st.CliVersion)
	}
	out, err := json.Marshal(st)
	if err != nil || !strings.Contains(string(out), `"cliVersion":"2026.10.7-rc.2"`) {
		t.Fatalf("cliVersion must reach the published snapshot; got %s (%v)", out, err)
	}
}

func TestReadMigrationStatusOlderCliHasNoVersion(t *testing.T) {
	// A CLI that predates the field writes none; the snapshot must then omit it
	// (the backend reads "absent" as "not reported", never as a version).
	p := filepath.Join(t.TempDir(), "status.json")
	if err := os.WriteFile(p, []byte(`{"schema":1,"mode":"enforce","ok":true,"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := readMigrationStatus(p)
	out, _ := json.Marshal(st)
	if strings.Contains(string(out), "cliVersion") {
		t.Fatalf("an absent cliVersion must stay absent; got %s", out)
	}
}

func TestReadMigrationStatusRelaysPhaseAndDeferred(t *testing.T) {
	// ADR-064: an after-services script waits ("deferred") until the services run
	// its release. The upgrade run reads both fields to know when a node is done;
	// dropping either in the relay would hold the run or end it early.
	p := filepath.Join(t.TempDir(), "status.json")
	body := `{"schema":1,"cliVersion":"2026.10.7","mode":"enforce","ok":true,"items":[` +
		`{"key":"2026.10.7/0001-a.sh","state":"applied","phase":"before-services"},` +
		`{"key":"2026.10.7/0002-b.sh","state":"deferred","phase":"after-services"},` +
		`{"key":"2026.10.6/0001-c.sh","state":"applied"}]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, errs := readMigrationStatus(p)
	if len(errs) != 0 || st == nil {
		t.Fatalf("unexpected: %v / %v", st, errs)
	}
	out, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"phase":"before-services"`, `"phase":"after-services"`, `"state":"deferred"`} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("%s must reach the published snapshot; got %s", want, out)
		}
	}
	// A script from a CLI that predates phases carries none — it stays absent.
	if strings.Count(string(out), `"phase"`) != 2 {
		t.Fatalf("an absent phase must stay absent; got %s", out)
	}
}

func TestReadMigrationStatusClipsAHostilePhase(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	long := strings.Repeat("x", 10000)
	body := `{"schema":1,"mode":"enforce","ok":true,"items":[{"key":"2026.10.7/0001-a.sh","state":"applied","phase":"` + long + `"}]}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := readMigrationStatus(p)
	if st == nil || len(st.Items) != 1 || st.Items[0].Phase == nil || len(*st.Items[0].Phase) >= 10000 {
		t.Fatalf("a hostile phase must be clipped, got %+v", st)
	}
}

func TestReadMigrationStatusRelaysTrustAnchor(t *testing.T) {
	// ADR-064 §6: the upgrade pre-flight refuses to push a release to a node that
	// cannot verify it. Dropping the field would hide exactly that node.
	dir := t.TempDir()
	for _, tc := range []struct {
		body, want string
	}{
		{`{"schema":1,"trustAnchor":false,"mode":"enforce","ok":true,"items":[]}`, `"trustAnchor":false`},
		{`{"schema":1,"trustAnchor":true,"mode":"enforce","ok":true,"items":[]}`, `"trustAnchor":true`},
	} {
		p := filepath.Join(dir, "status.json")
		if err := os.WriteFile(p, []byte(tc.body), 0o644); err != nil {
			t.Fatal(err)
		}
		st, _ := readMigrationStatus(p)
		out, _ := json.Marshal(st)
		if !strings.Contains(string(out), tc.want) {
			t.Fatalf("want %s in %s", tc.want, out)
		}
	}
	// An older CLI writes none — it stays absent, never false.
	p := filepath.Join(dir, "status.json")
	if err := os.WriteFile(p, []byte(`{"schema":1,"mode":"enforce","ok":true,"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := readMigrationStatus(p)
	out, _ := json.Marshal(st)
	if strings.Contains(string(out), "trustAnchor") {
		t.Fatalf("an absent trustAnchor must stay absent; got %s", out)
	}
}
