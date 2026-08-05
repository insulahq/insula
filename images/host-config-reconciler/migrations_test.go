package main

import (
	"os"
	"path/filepath"
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
