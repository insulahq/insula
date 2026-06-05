package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// buildFixtureDb writes a fail2ban-1.x-shaped sqlite DB under
// <root>/var/lib/fail2ban/fail2ban.sqlite3.
func buildFixtureDb(t *testing.T, root string, now time.Time) {
	t.Helper()
	dir := filepath.Join(root, "var/lib/fail2ban")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "fail2ban.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stmts := []string{
		`CREATE TABLE bans (jail TEXT, ip TEXT, timeofban INTEGER, bantime INTEGER, bancount INTEGER, data JSON)`,
		`CREATE TABLE bips (ip TEXT, jail TEXT, timeofban INTEGER, bantime INTEGER, bancount INTEGER, data JSON)`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	ins := func(jail, ip string, tob, bantime int64, bancount int) {
		if _, err := db.Exec(`INSERT INTO bans (jail, ip, timeofban, bantime, bancount, data) VALUES (?,?,?,?,?, '{}')`,
			jail, ip, tob, bantime, bancount); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO bips (ip, jail, timeofban, bantime, bancount, data) VALUES (?,?,?,?,?, '{}')`,
			ip, jail, tob, bantime, bancount); err != nil {
			t.Fatal(err)
		}
	}
	// Active 1h ban from 10 min ago (recent).
	ins("sshd", "203.0.113.10", now.Add(-10*time.Minute).Unix(), 3600, 2)
	// Permanent ban from 3 days ago (current, NOT last-24h).
	ins("sshd", "198.51.100.7", now.Add(-72*time.Hour).Unix(), -1, 9)
	// Expired ban left unpurged: 2h old, 1h bantime.
	ins("sshd", "192.0.2.99", now.Add(-2*time.Hour).Unix(), 3600, 1)
}

func TestCollectFail2ban(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	buildFixtureDb(t, root, now)

	st := collectFail2ban(root, now)
	if !st.DbPresent {
		t.Fatalf("DbPresent=false, readError=%v", st.ReadError)
	}
	if st.BannedNowCount != 2 {
		t.Fatalf("BannedNowCount=%d want 2 (expired row must be excluded)", st.BannedNowCount)
	}
	// 24h window counts ACTIVITY (incl. the now-expired 2h-old ban) —
	// it answers "how much brute-force pressure recently", not "how
	// many of those bans still stand" (that's BannedNowCount).
	if st.BansLast24h != 2 {
		t.Fatalf("BansLast24h=%d want 2", st.BansLast24h)
	}
	if st.BansTotal != 3 {
		t.Fatalf("BansTotal=%d want 3 (bips count)", st.BansTotal)
	}
	if len(st.CurrentlyBanned) != 2 {
		t.Fatalf("CurrentlyBanned=%d want 2", len(st.CurrentlyBanned))
	}
	// Newest first.
	if st.CurrentlyBanned[0].IP != "203.0.113.10" {
		t.Fatalf("order: got %s first", st.CurrentlyBanned[0].IP)
	}
	if st.CurrentlyBanned[0].ExpiresAt == nil {
		t.Fatal("1h ban must carry expiresAt")
	}
	if st.CurrentlyBanned[1].ExpiresAt != nil {
		t.Fatal("permanent ban (bantime -1) must have expiresAt=nil")
	}
	if st.CurrentlyBanned[1].BanCount != 9 {
		t.Fatalf("banCount=%d want 9", st.CurrentlyBanned[1].BanCount)
	}
}

func TestCollectFail2banNoDb(t *testing.T) {
	st := collectFail2ban(t.TempDir(), time.Now())
	if st.DbPresent {
		t.Fatal("DbPresent must be false without a DB")
	}
	if st.ReadError == nil {
		t.Fatal("ReadError must explain the missing DB")
	}
	if len(st.CurrentlyBanned) != 0 || st.BannedNowCount != 0 {
		t.Fatal("zero-valued counts expected")
	}
}

func TestCollectFail2banLegacySchema(t *testing.T) {
	// 0.10-era DB: no bantime/bancount columns — every row counts as
	// current, no expiry computable.
	root := t.TempDir()
	dir := filepath.Join(root, "var/lib/fail2ban")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "fail2ban.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE bans (jail TEXT, ip TEXT, timeofban INTEGER, data JSON)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO bans VALUES ('sshd', '203.0.113.77', ?, '{}')`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	db.Close()

	st := collectFail2ban(root, time.Now())
	if !st.DbPresent {
		t.Fatalf("legacy DB must still parse, readError=%v", st.ReadError)
	}
	if st.BannedNowCount != 1 {
		t.Fatalf("BannedNowCount=%d want 1", st.BannedNowCount)
	}
	if st.CurrentlyBanned[0].ExpiresAt != nil {
		t.Fatal("legacy rows cannot compute expiresAt")
	}
	if st.BansTotal != 1 {
		t.Fatalf("BansTotal=%d want 1 (bans fallback when bips absent)", st.BansTotal)
	}
}
