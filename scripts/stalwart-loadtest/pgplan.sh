#!/usr/bin/env bash
# pgplan.sh — why v1's PostgreSQL full-text search sometimes reads a whole account (ADR-065, store
# evaluation finding 1). Run next to lt.sh on the lab node, after `lt.sh init`:
#   RUN=<id> [FASTUPDATE=off] ./pgplan.sh
# Fresh v1-pg store, then the JMAP text search for the big account as v1 issues it, EXPLAINed
# (a) right after the ingest, (b) after VACUUM only (merges the GIN pending lists), (c) after
# ANALYZE, each followed by a 60 s JMAP read. FASTUPDATE=off first turns the GIN indexes' pending
# lists off (every insert then updates the index itself). Results in results/<RUN>/pgplan/.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
RUN=${RUN:?RUN}; OUT=$PWD/results/$RUN; P=$OUT/pgplan; mkdir -p "$P"
export RUN
K="k3s kubectl -n mail-lt"
sql() { $K exec -i lt-pg-1 -c postgres -- psql -U postgres -d stalwart -v ON_ERROR_STOP=1 -At "$@"; }
./lt.sh stalwart-up v1-pg > "$P/up.log" 2>&1 || { echo "stalwart-up failed"; tail -5 "$P/up.log"; exit 1; }
if [[ ${FASTUPDATE:-on} == off ]]; then  # GIN without a pending list: every insert updates the index
  for i in $(sql -c "SELECT indexrelid::regclass FROM pg_index WHERE indrelid = 's_email'::regclass AND indexrelid::regclass::text LIKE 'gin_%'"); do
    sql -c "ALTER INDEX $i SET (fastupdate = off)" >/dev/null
  done
  echo "fastupdate off on: $(sql -c "SELECT string_agg(c.relname || '=' || coalesce(array_to_string(c.reloptions, ','), '-'), ' ') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 's_email'::regclass AND c.relname LIKE 'gin_%'")"
fi
./lt.sh phase v1-pg append append --accounts 50 --per-account 600 --big 25000 --workers 8 >> "$P/up.log" 2>&1
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('append', d['msg_per_s'], 'msg/s, p95', d['latency_ms']['append']['p95'], 'ms')" "$OUT/v1-pg/append.json"
sql -c "CREATE EXTENSION IF NOT EXISTS pgstattuple" >/dev/null
acc=$(sql -c "SELECT accid FROM s_email GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")
echo "big account: $acc ($(sql -c "SELECT count(*) FROM s_email WHERE accid = $acc") rows of $(sql -c "SELECT count(*) FROM s_email"))"
Q="SELECT docid FROM s_email WHERE (fadr @@ (SELECT plainto_tsquery('simple', 'zq510x')) OR tadr @@ (SELECT plainto_tsquery('simple', 'zq510x')) OR cc @@ (SELECT plainto_tsquery('simple', 'zq510x')) OR bcc @@ (SELECT plainto_tsquery('simple', 'zq510x')) OR subj @@ (SELECT (plainto_tsquery('english', 'zq510x') || plainto_tsquery('simple', 'zq510x'))) OR body @@ (SELECT (plainto_tsquery('english', 'zq510x') || plainto_tsquery('simple', 'zq510x'))) OR atta @@ (SELECT (plainto_tsquery('english', 'zq510x') || plainto_tsquery('simple', 'zq510x')))) AND accid = $acc"
step() {  # <label>
  {
    echo "== $1"
    sql -c "SELECT n_live_tup, n_mod_since_analyze, last_autoanalyze, last_analyze, last_autovacuum, last_vacuum FROM pg_stat_user_tables WHERE relname = 's_email'"
    sql -c "SELECT indexrelid::regclass, (pgstatginindex(indexrelid)).pending_pages, (pgstatginindex(indexrelid)).pending_tuples FROM pg_index WHERE indrelid = 's_email'::regclass AND indexrelid::regclass::text LIKE 'gin_%' ORDER BY 1"
    sql -c "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) $Q"
  } > "$P/$1.txt" 2>&1
  echo "$1: $(grep -m1 -E 'Bitmap Index Scan on|Seq Scan|Index Scan' "$P/$1.txt" | sed 's/^ *//' | cut -c1-80) — $(grep -E '^Execution Time' "$P/$1.txt")"
  ./lt.sh phase v1-pg "jmap-$1" jmap-read --accounts 50 --duration 60 --workers 16 > /dev/null 2>&1
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); s=d['latency_ms']['search_text']; print('   jmap', d['ops_per_s'], 'ops/s, search_text p50/p95', s['p50'], s['p95'])" "$OUT/v1-pg/jmap-$1.json"
}
step a-after-ingest
sql -c "VACUUM s_email" >/dev/null
step b-after-vacuum
sql -c "ANALYZE s_email" >/dev/null
step c-after-analyze
./lt.sh stalwart-down >/dev/null 2>&1
echo "done: $P"
