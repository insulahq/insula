package main

// fail2ban collector — reads the per-node fail2ban state from its
// sqlite DB at <hostRoot>/var/lib/fail2ban/fail2ban.sqlite3.
//
// READ-ONLY BY CONSTRUCTION: the DaemonSet mounts /var/lib/fail2ban
// read-only and the DSN uses mode=ro&immutable=1 — no locks taken, no
// -wal/-shm files created, no way to mutate state. We deliberately do
// NOT talk to the fail2ban control socket (/var/run/fail2ban.sock):
// that is a write-capable channel (ban/unban) and would break this
// probe's drop-ALL-caps / read-only posture. The trade-off is that
// fail2ban's in-memory "currently failed" counters are not available —
// only the persisted ban state is.
//
// immutable=1 means sqlite assumes the file cannot change mid-read; a
// concurrent fail2ban write can therefore yield a transient malformed
// read. That is acceptable for a 60s-cadence posture probe — we report
// the error string and the next tick retries.
//
// Schema notes (fail2ban 0.11+/1.x): `bans` holds CURRENT bans
// (jail, ip, timeofban, bantime, bancount, data); rows are removed on
// unban/expiry-purge. `bips` is the all-time per-IP aggregate. bantime
// -1 = permanent. Older 0.10 DBs lack bantime/bancount columns — we
// detect via PRAGMA and degrade to timeofban-only rows.

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

const fail2banDbRelPath = "var/lib/fail2ban/fail2ban.sqlite3"

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func strPtr(s string) *string { return &s }

// fail2banBannedCap bounds the wire payload (contract caps at 200).
const fail2banBannedCap = 200

func collectFail2ban(hostRoot string, now time.Time) Fail2banStatus {
	st := Fail2banStatus{CurrentlyBanned: []Fail2banBannedIP{}}

	dbPath := filepath.Join(hostRoot, fail2banDbRelPath)
	if !fileExists(dbPath) {
		st.ReadError = strPtr("fail2ban state DB not found (fail2ban not installed or never started)")
		return st
	}

	dsn := fmt.Sprintf("file:%s?mode=ro&immutable=1", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		st.ReadError = strPtr("open: " + err.Error())
		return st
	}
	defer db.Close()

	hasBantime, hasBancount, err := fail2banColumns(db)
	if err != nil {
		st.ReadError = strPtr("schema probe: " + err.Error())
		return st
	}

	rows, err := queryFail2banBans(db, hasBantime, hasBancount)
	if err != nil {
		st.ReadError = strPtr("bans query: " + err.Error())
		return st
	}

	cutoff24h := now.Add(-24 * time.Hour).Unix()
	for _, r := range rows {
		if r.timeofban >= cutoff24h {
			st.BansLast24h++
		}
		// Without a bantime column we cannot compute expiry — treat every
		// row in `bans` as current (fail2ban purges expired rows itself).
		expired := hasBantime && r.bantime >= 0 && r.timeofban+r.bantime <= now.Unix()
		if expired {
			continue
		}
		st.BannedNowCount++
		if len(st.CurrentlyBanned) >= fail2banBannedCap {
			continue
		}
		entry := Fail2banBannedIP{
			IP:       r.ip,
			Jail:     r.jail,
			BanCount: r.bancount,
		}
		if r.timeofban > 0 {
			entry.BannedAt = strPtr(time.Unix(r.timeofban, 0).UTC().Format(time.RFC3339))
		}
		if hasBantime && r.bantime >= 0 && r.timeofban > 0 {
			entry.ExpiresAt = strPtr(time.Unix(r.timeofban+r.bantime, 0).UTC().Format(time.RFC3339))
		}
		st.CurrentlyBanned = append(st.CurrentlyBanned, entry)
	}

	// Newest ban first — the interesting rows for an operator.
	sort.Slice(st.CurrentlyBanned, func(i, j int) bool {
		a, b := st.CurrentlyBanned[i].BannedAt, st.CurrentlyBanned[j].BannedAt
		switch {
		case a == nil:
			return false
		case b == nil:
			return true
		default:
			return *a > *b
		}
	})

	// All-time aggregate. `bips` exists since 0.11; fall back to the bans
	// row count when absent.
	if err := db.QueryRow(`SELECT COUNT(*) FROM bips`).Scan(&st.BansTotal); err != nil {
		st.BansTotal = len(rows)
	}

	st.DbPresent = true
	return st
}

type fail2banBanRow struct {
	jail      string
	ip        string
	timeofban int64
	bantime   int64
	bancount  int
}

// fail2banColumns detects the 0.11+ columns via PRAGMA so 0.10-era DBs
// degrade instead of erroring.
func fail2banColumns(db *sql.DB) (hasBantime, hasBancount bool, err error) {
	rows, err := db.Query(`PRAGMA table_info(bans)`)
	if err != nil {
		return false, false, err
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, false, err
		}
		found = true
		switch name {
		case "bantime":
			hasBantime = true
		case "bancount":
			hasBancount = true
		}
	}
	if !found {
		return false, false, fmt.Errorf("no `bans` table")
	}
	return hasBantime, hasBancount, rows.Err()
}

func queryFail2banBans(db *sql.DB, hasBantime, hasBancount bool) ([]fail2banBanRow, error) {
	q := `SELECT jail, ip, CAST(timeofban AS INTEGER)`
	if hasBantime {
		q += `, CAST(bantime AS INTEGER)`
	}
	if hasBancount {
		q += `, bancount`
	}
	q += ` FROM bans`

	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []fail2banBanRow
	for rows.Next() {
		r := fail2banBanRow{bantime: -1, bancount: 1}
		dest := []any{&r.jail, &r.ip, &r.timeofban}
		if hasBantime {
			dest = append(dest, &r.bantime)
		}
		if hasBancount {
			dest = append(dest, &r.bancount)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
