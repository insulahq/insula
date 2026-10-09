#!/usr/bin/env bash
# vmsingle-memory-report.sh — compare vmsingle memory across process runs at
# EQUAL UPTIME, plus the nightly next-day index pre-fill.
#
# vmsingle's memory grows with uptime, so "before vs after" a configuration
# change is only meaningful between processes of the same age. Give the start
# time of each run (the vmsingle container's startedAt, UTC) and this prints
# memory, GC pressure and series counts at fixed uptime marks for each, using
# vmsingle's own stored self-metrics.
#
# Runs the queries from inside the platform-api pod (which may reach vmsingle);
# needs kubectl access to the cluster.
#
# USAGE
#   scripts/vmsingle-memory-report.sh LABEL=START [LABEL=START ...]
#   e.g. scripts/vmsingle-memory-report.sh before=<startedAt of the old run> after=<startedAt of the new run>
#   Current start time:
#     kubectl -n monitoring get pod -l app=vmsingle \
#       -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="vmsingle")].state.running.startedAt}'
#
# READING IT
#   rssMiB / heapFloorMiB   resident memory; lowest live heap in the last 10 min
#                           (noisy when the heap is small — compare RSS first)
#   nextGc/floor            ~1.40 = GOGC in control; drifting to 1.0 = GOMEMLIMIT
#                           binding, the GC spiral that precedes an OOM
#   activeSeries            series with a sample in the last 5 min
#   prefill                 per-day index inserts in the 23:00-24:00 UTC hour,
#                           when vmsingle pre-builds the next day's index
set -euo pipefail

[[ $# -ge 1 ]] || { sed -n '2,30p' "$0"; exit 2; }
KUBECTL="${KUBECTL:-kubectl}"

runs="["
for arg in "$@"; do
  label="${arg%%=*}"; start="${arg#*=}"
  [[ "$label" != "$arg" && "$start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] \
    || { echo "bad argument '$arg' — expected LABEL=YYYY-MM-DDTHH:MM:SSZ" >&2; exit 2; }
  runs+="{label:'$label',start:'$start'},"
done
runs+="]"

pod=$($KUBECTL -n platform get pods -l app=platform-api --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')
[[ -n "$pod" ]] || { echo "no running platform-api pod" >&2; exit 1; }

$KUBECTL -n platform exec -i "$pod" -- node --input-type=module - <<EOF
const RUNS = $runs;
const MARKS = [['25m',1500],['1h',3600],['3h',10800],['6h',21600],['12h',43200],['1d',86400],['2d',172800],['4d',345600],['6d',518400],['7d',604800]];
const base = 'http://vmsingle.monitoring.svc:8428/metrics/api/v1';
const J = 'job="vmsingle"';
const at = async (e, t) => {
  const j = await (await fetch(base + '/query?query=' + encodeURIComponent(e) + '&time=' + t)).json();
  const v = Number(j.data?.result?.[0]?.value?.[1]);
  return Number.isFinite(v) ? v : null;
};
const f = (v, d) => (v === null ? '-' : v.toFixed(d));
const COLS = [
  ['rssMiB', 'process_resident_memory_bytes{' + J + '}/2^20', 0],
  ['heapFloorMiB', 'min_over_time(go_memstats_alloc_bytes{' + J + '}[10m])/2^20', 0],
  ['nextGc/floor', 'go_memstats_next_gc_bytes{' + J + '} / min_over_time(go_memstats_alloc_bytes{' + J + '}[10m])', 2],
  ['gc/s', 'rate(go_gc_duration_seconds_count{' + J + '}[10m])', 2],
  ['cachesMiB', 'sum(vm_cache_size_bytes{' + J + '})/2^20', 0],
  ['activeSeries', 'count(last_over_time({__name__!=""}[5m]))', 0],
];
const now = Date.now() / 1000;
const starts = RUNS.map((r) => Date.parse(r.start) / 1000).sort((a, b) => a - b);
const rows = [['run', 'uptime', ...COLS.map((c) => c[0])]];
for (const run of RUNS) {
  const s = Date.parse(run.start) / 1000;
  const next = starts.find((x) => x > s) ?? Infinity;   // a run ends where the next one starts
  for (const [label, sec] of MARKS) {
    const t = s + sec;
    if (t > now - 60 || t >= next) continue;
    const vals = [];
    for (const [, e, d] of COLS) vals.push(f(await at(e, t), d));
    rows.push([run.label, label, ...vals]);
  }
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i])).join('  '));

console.log('');
console.log('nightly next-day index pre-fill, 23:00-24:00 UTC (last 7 nights):');
for (let d = 1; d <= 7; d++) {
  const end = Math.floor(now / 86400) * 86400 - (d - 1) * 86400;   // 00:00 UTC
  if (end > now) continue;
  const day = new Date((end - 3600) * 1000).toISOString().slice(0, 10);
  const ins = await at('increase(vm_slow_per_day_index_inserts_total{' + J + '}[1h])', end);
  const gc = await at('rate(go_gc_duration_seconds_count{' + J + '}[1h])', end);
  const rss = await at('max_over_time(process_resident_memory_bytes{' + J + '}[1h])/2^20', end);
  console.log('  ' + day + '  inserts ' + f(ins, 0).padStart(6) + '   gc/s ' + f(gc, 2) + '   max rss ' + f(rss, 0) + ' MiB');
}
EOF
