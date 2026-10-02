#!/usr/bin/env python3
"""
insula-stall-watch — a temporary evidence recorder for host storage / vCPU stalls.

Some VPS nodes stall for 8-48 s at a time: the guest is idle, then every
write to its disk — etcd's fsync, Longhorn's replica I/O — waits for tens of
seconds, and etcd loses quorum or Longhorn salvages a volume. The journal shows
the damage but not the stall itself, and nothing timestamps what the
hypervisor's memory balloon was doing. This records both, for a bounded period,
so a ticket to the provider can carry a timeline instead of an impression.

What it records (all times UTC), under /var/log/insula-stall-watch/:
  events.tsv   one line per stall it OBSERVED:
                 fsync  — a 4 KiB write + fdatasync on the root filesystem (the
                          disk etcd and Longhorn use) took >= 1 s
                 frozen — this process's 1-second loop woke up >= 2 s late: the
                          process, or the whole vCPU, was not running
  minutes.tsv  one line per minute: worst fsync / lateness, memory-balloon page
               movements, CPU steal and iowait, I/O and memory pressure (PSI)
  daily.tsv    one line per UTC day: the counts above plus the journal
               signatures of a stall (etcd slow applies, RCU stalls, hung tasks,
               iSCSI connection errors, filesystem I/O errors, "Out of puff",
               k3s exits, Longhorn replica R/W timeouts)

Subcommands:
  run                  the recorder (systemd); exits on its own at STOP_AT
  report [--events N]  print the daily table (+ today so far) and recent events
  summarize DAY        (re)compute one UTC day, YYYY-MM-DD, and print it
  backfill DAYS        journal-only summaries for the past DAYS days (the probe
                       columns read "-": the recorder was not running then)
  selftest             parser checks, no host access needed

Config: /etc/insula-stall-watch.conf with `STOP_AT=<ISO-8601 UTC>`.
Footprint: one write of 4 KiB per second to one file, ~3 MB of logs per 14 days.
"""
from __future__ import annotations

import datetime as dt
import glob
import os
import re
import subprocess
import sys
import time
from typing import Iterable

STATE_DIR = os.environ.get('STALL_WATCH_STATE_DIR', '/var/lib/insula-stall-watch')
LOG_DIR = os.environ.get('STALL_WATCH_LOG_DIR', '/var/log/insula-stall-watch')
CONF = os.environ.get('STALL_WATCH_CONF', '/etc/insula-stall-watch.conf')

PROBE_INTERVAL_S = 1.0
FSYNC_STALL_S = 1.0
FROZEN_STALL_S = 2.0
ETCD_SLOW_S = 1.0
MAX_EVENT_LINES = 20_000
PAGE_KIB = 4

EVENTS_HEADER = 'observed_at\tkind\tseconds\tstarted_at\n'
MINUTES_HEADER = ('minute\tsamples\tfsync_max_ms\tfsync_mean_ms\tlate_max_ms\tballoon_inflate_kib\t'
                  'balloon_deflate_kib\tsteal_pct\tiowait_pct\tpsi_io_full_avg60\tpsi_mem_full_avg60\t'
                  'mem_available_mib\n')
DAILY_COLUMNS = [
    'day', 'source', 'fsync_stalls', 'fsync_stalls_5s', 'fsync_max_s', 'frozen', 'frozen_max_s',
    'etcd_slow_1s', 'etcd_max_s', 'rcu_stalls', 'hung_tasks', 'iscsi_conn_errors', 'fs_io_errors',
    'balloon_out_of_puff', 'balloon_inflate_mib', 'balloon_deflate_mib', 'k3s_exits',
    'longhorn_rw_timeouts', 'steal_max_pct',
]

# ── pure helpers (covered by `selftest`) ──────────────────────────────────

_GO_DURATION = re.compile(r'(\d+(?:\.\d+)?)(h|ms|us|µs|μs|ns|m|s)')
_GO_UNITS = {'h': 3600.0, 'm': 60.0, 's': 1.0, 'ms': 1e-3, 'us': 1e-6, 'µs': 1e-6, 'μs': 1e-6, 'ns': 1e-9}


def parse_go_duration(text: str) -> float | None:
    """Seconds in a Go duration string such as "1m2.5s" or "152.48ms"; None if unparseable."""
    parts = _GO_DURATION.findall(text)
    if not parts or ''.join(n + u for n, u in parts) != text:
        return None
    return sum(float(n) * _GO_UNITS[u] for n, u in parts)


_ETCD_SLOW = re.compile(r'"msg":"(apply request took too long|slow fdatasync)".*?"took":"([^"]+)"')


def etcd_slow_seconds(line: str) -> float | None:
    """Duration of an etcd slow-apply / slow-fdatasync warning in a k3s journal line."""
    m = _ETCD_SLOW.search(line)
    return parse_go_duration(m.group(2)) if m else None


KERNEL_SIGNATURES: list[tuple[str, re.Pattern[str]]] = [
    ('rcu_stalls', re.compile(r'rcu_\w+ detected stalls|rcu_\w+ kthread starved')),
    ('hung_tasks', re.compile(r'blocked for more than \d+ seconds')),
    ('iscsi_conn_errors', re.compile(r'detected conn error')),
    ('fs_io_errors', re.compile(r'log I/O error|Filesystem has been shut down|EXT4-fs error|Buffer I/O error')),
    ('balloon_out_of_puff', re.compile(r'Out of puff')),
]


def classify_kernel_line(line: str) -> str | None:
    for key, pattern in KERNEL_SIGNATURES:
        if pattern.search(line):
            return key
    return None


# One line per exit: systemd also logs "Failed with result" for the same exit,
# so matching both would count every exit twice.
_K3S_EXIT = re.compile(r'k3s(?:-agent)?\.service: Main process exited, code=(?!exited, status=0/)')


def is_k3s_exit(line: str) -> bool:
    return bool(_K3S_EXIT.search(line))


def proc_stat_cpu(text: str) -> list[int]:
    """The aggregate `cpu` line of /proc/stat as integers."""
    for line in text.splitlines():
        if line.startswith('cpu '):
            return [int(x) for x in line.split()[1:]]
    return []


def cpu_pcts(prev: list[int], cur: list[int]) -> tuple[float, float]:
    """(steal %, iowait %) between two /proc/stat cpu samples."""
    if len(prev) < 8 or len(cur) < 8:
        return (0.0, 0.0)
    delta = [c - p for c, p in zip(cur[:8], prev[:8])]
    total = sum(delta) or 1
    return (100.0 * delta[7] / total, 100.0 * delta[4] / total)


def psi_avg60(text: str, kind: str) -> float:
    """avg60 of the `some`/`full` line of a /proc/pressure file."""
    for line in text.splitlines():
        if line.startswith(kind + ' '):
            m = re.search(r'avg60=([\d.]+)', line)
            return float(m.group(1)) if m else 0.0
    return 0.0


def vmstat_fields(text: str, names: Iterable[str]) -> dict[str, int]:
    wanted = set(names)
    out = {n: 0 for n in wanted}
    for line in text.splitlines():
        k, _, v = line.partition(' ')
        if k in wanted:
            out[k] = int(v)
    return out


def fmt_seconds(value: float | None) -> str:
    return '-' if value is None else f'{value:.2f}'


# ── host access ───────────────────────────────────────────────────────────

def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def read(path: str) -> str:
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            return fh.read()
    except OSError:
        return ''


def stop_at() -> dt.datetime | None:
    for line in read(CONF).splitlines():
        if line.startswith('STOP_AT='):
            try:
                return dt.datetime.fromisoformat(line.split('=', 1)[1].strip().replace('Z', '+00:00'))
            except ValueError:
                return None
    return None


def append(path: str, header: str, line: str) -> None:
    new = not os.path.exists(path)
    with open(path, 'a', encoding='utf-8') as fh:
        if new:
            fh.write(header)
        fh.write(line)


def journal(day: dt.date, *args: str) -> list[str]:
    since = f'{day.isoformat()} 00:00:00 UTC'
    until = f'{(day + dt.timedelta(days=1)).isoformat()} 00:00:00 UTC'
    try:
        res = subprocess.run(
            ['journalctl', '--utc', '--no-pager', '-o', 'short-iso', '--since', since, '--until', until, *args],
            capture_output=True, text=True, timeout=300, check=False,
        )
        return res.stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        return []


def k3s_unit() -> str:
    for unit in ('k3s', 'k3s-agent'):
        if os.path.exists(f'/etc/systemd/system/{unit}.service'):
            return unit
    return 'k3s'


def longhorn_rw_timeouts(day: dt.date) -> int | None:
    """Longhorn engine R/W timeouts on this node (container logs; rotated, so best effort)."""
    files = glob.glob('/var/log/pods/longhorn-system_instance-manager-*/*/*.log*')
    if not files:
        return None
    prefix = day.isoformat()
    n = 0
    for path in files:
        if path.endswith('.gz'):
            continue
        try:
            with open(path, encoding='utf-8', errors='replace') as fh:
                n += sum(1 for line in fh if line.startswith(prefix) and 'R/W Timeout' in line)
        except OSError:
            continue
    return n


def journal_counts(day: dt.date) -> dict[str, str]:
    counts = {k: 0 for k, _ in KERNEL_SIGNATURES}
    for line in journal(day, '-k'):
        key = classify_kernel_line(line)
        if key:
            counts[key] += 1
    k3s_lines = journal(day, '-u', k3s_unit())
    slow = [s for s in (etcd_slow_seconds(l) for l in k3s_lines) if s is not None]
    slow_1s = [s for s in slow if s >= ETCD_SLOW_S]
    exits = sum(1 for l in k3s_lines if is_k3s_exit(l))
    lh = longhorn_rw_timeouts(day)
    out = {k: str(v) for k, v in counts.items()}
    out.update({
        'etcd_slow_1s': str(len(slow_1s)),
        'etcd_max_s': fmt_seconds(max(slow_1s)) if slow_1s else '0',
        'k3s_exits': str(exits),
        'longhorn_rw_timeouts': '-' if lh is None else str(lh),
    })
    return out


def probe_counts(day: dt.date) -> dict[str, str]:
    prefix = day.isoformat()
    fs, fs5, fmax, fr, frmax = 0, 0, 0.0, 0, 0.0
    seen = False
    for line in read(os.path.join(LOG_DIR, 'events.tsv')).splitlines()[1:]:
        cols = line.split('\t')
        if len(cols) < 3 or not cols[0].startswith(prefix):
            continue
        seen = True
        secs = float(cols[2])
        if cols[1] == 'fsync':
            fs += 1
            fs5 += secs >= 5
            fmax = max(fmax, secs)
        elif cols[1] == 'frozen':
            fr += 1
            frmax = max(frmax, secs)
    infl = defl = 0
    steal_max = 0.0
    for line in read(os.path.join(LOG_DIR, 'minutes.tsv')).splitlines()[1:]:
        cols = line.split('\t')
        if len(cols) < 12 or not cols[0].startswith(prefix):
            continue
        seen = True
        infl += int(cols[5])
        defl += int(cols[6])
        steal_max = max(steal_max, float(cols[7]))
    if not seen:
        return {k: '-' for k in ('fsync_stalls', 'fsync_stalls_5s', 'fsync_max_s', 'frozen', 'frozen_max_s',
                                 'balloon_inflate_mib', 'balloon_deflate_mib', 'steal_max_pct')}
    return {
        'fsync_stalls': str(fs), 'fsync_stalls_5s': str(fs5), 'fsync_max_s': fmt_seconds(fmax),
        'frozen': str(fr), 'frozen_max_s': fmt_seconds(frmax),
        'balloon_inflate_mib': str(infl // 1024), 'balloon_deflate_mib': str(defl // 1024),
        'steal_max_pct': f'{steal_max:.1f}',
    }


def summarize(day: dt.date, source: str) -> str:
    row = {'day': day.isoformat(), 'source': source}
    row.update(probe_counts(day) if source == 'probe' else {
        k: '-' for k in ('fsync_stalls', 'fsync_stalls_5s', 'fsync_max_s', 'frozen', 'frozen_max_s',
                         'balloon_inflate_mib', 'balloon_deflate_mib', 'steal_max_pct')})
    row.update(journal_counts(day))
    return '\t'.join(row.get(c, '-') for c in DAILY_COLUMNS) + '\n'


def write_daily(day: dt.date, source: str) -> str:
    """Replace any previous line for `day` in daily.tsv and return the new one."""
    path = os.path.join(LOG_DIR, 'daily.tsv')
    line = summarize(day, source)
    kept = [l for l in read(path).splitlines(keepends=True)[1:] if not l.startswith(day.isoformat() + '\t')]
    rows = sorted(kept + [line])
    tmp = path + '.new'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write('\t'.join(DAILY_COLUMNS) + '\n')
        fh.writelines(rows)
    os.replace(tmp, path)
    return line


# ── the recorder ──────────────────────────────────────────────────────────

def write_minute(
    path: str, minute: dt.datetime, fsyncs: list[float], late_max: float,
    vm_prev: dict[str, int], cpu_prev: list[int],
) -> tuple[dict[str, int], list[int]]:
    """Append one minutes.tsv line; return the counters it consumed, for the next minute."""
    vm = vmstat_fields(read('/proc/vmstat'), ('balloon_inflate', 'balloon_deflate'))
    cpu = proc_stat_cpu(read('/proc/stat'))
    steal, iowait = cpu_pcts(cpu_prev, cpu)
    avail = re.search(r'MemAvailable:\s+(\d+)', read('/proc/meminfo'))
    append(path, MINUTES_HEADER, '\t'.join([
        iso(minute), str(len(fsyncs)),
        f'{1000 * max(fsyncs, default=0):.1f}',
        f'{1000 * (sum(fsyncs) / len(fsyncs) if fsyncs else 0):.1f}',
        f'{1000 * late_max:.1f}',
        str((vm['balloon_inflate'] - vm_prev['balloon_inflate']) * PAGE_KIB),
        str((vm['balloon_deflate'] - vm_prev['balloon_deflate']) * PAGE_KIB),
        f'{steal:.2f}', f'{iowait:.2f}',
        f'{psi_avg60(read("/proc/pressure/io"), "full"):.2f}',
        f'{psi_avg60(read("/proc/pressure/memory"), "full"):.2f}',
        str(int(avail.group(1)) // 1024 if avail else 0),
    ]) + '\n')
    return vm, cpu


def run() -> int:
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    deadline = stop_at()
    if deadline is None:
        print('stall-watch: no STOP_AT in ' + CONF + ' — refusing to run unbounded', file=sys.stderr)
        return 1
    if utcnow() >= deadline:
        print(f'stall-watch: past STOP_AT {iso(deadline)} — nothing to do')
        return 0
    print(f'stall-watch: recording until {iso(deadline)}', flush=True)

    events_path = os.path.join(LOG_DIR, 'events.tsv')
    minutes_path = os.path.join(LOG_DIR, 'minutes.tsv')
    fd = os.open(os.path.join(STATE_DIR, 'probe'), os.O_WRONLY | os.O_CREAT, 0o600)
    block = os.urandom(4096)

    minute = utcnow().replace(second=0, microsecond=0)
    day = minute.date()
    fsyncs: list[float] = []
    late_max = 0.0
    vm_prev = vmstat_fields(read('/proc/vmstat'), ('balloon_inflate', 'balloon_deflate'))
    cpu_prev = proc_stat_cpu(read('/proc/stat'))
    event_lines = max(0, len(read(events_path).splitlines()) - 1)
    planned_wake = time.monotonic()

    while utcnow() < deadline:
        woke = time.monotonic()
        late = woke - planned_wake
        late_max = max(late_max, late)
        if late >= FROZEN_STALL_S and event_lines < MAX_EVENT_LINES:
            now = utcnow()
            append(events_path, EVENTS_HEADER,
                   f'{iso(now)}\tfrozen\t{late:.2f}\t{iso(now - dt.timedelta(seconds=late))}\n')
            event_lines += 1

        t0 = time.monotonic()
        os.pwrite(fd, block, 0)
        os.fdatasync(fd)
        took = time.monotonic() - t0
        fsyncs.append(took)
        if took >= FSYNC_STALL_S and event_lines < MAX_EVENT_LINES:
            now = utcnow()
            append(events_path, EVENTS_HEADER,
                   f'{iso(now)}\tfsync\t{took:.2f}\t{iso(now - dt.timedelta(seconds=took))}\n')
            event_lines += 1

        now = utcnow()
        this_minute = now.replace(second=0, microsecond=0)
        if this_minute != minute:
            vm_prev, cpu_prev = write_minute(minutes_path, minute, fsyncs, late_max, vm_prev, cpu_prev)
            fsyncs, late_max, minute = [], 0.0, this_minute
            if this_minute.date() != day:
                try:
                    write_daily(day, 'probe')
                except Exception as err:  # a summary must never stop the recorder
                    print(f'stall-watch: daily summary for {day} failed: {err}', file=sys.stderr, flush=True)
                day = this_minute.date()

        planned_wake = time.monotonic() + max(0.0, PROBE_INTERVAL_S - (time.monotonic() - woke))
        time.sleep(max(0.0, planned_wake - time.monotonic()))

    if fsyncs:
        write_minute(minutes_path, minute, fsyncs, late_max, vm_prev, cpu_prev)
    write_daily(day, 'probe')
    print(f'stall-watch: reached STOP_AT {iso(deadline)} — done', flush=True)
    return 0


# ── reading it back ───────────────────────────────────────────────────────

def report(events: int) -> int:
    rows = read(os.path.join(LOG_DIR, 'daily.tsv')).splitlines()
    today = utcnow().date()
    print(f'# {os.uname().nodename} — stall-watch, STOP_AT {iso(stop_at()) if stop_at() else "unset"}')
    print('\t'.join(DAILY_COLUMNS))
    for line in rows[1:]:
        print(line)
    print(summarize(today, 'probe').rstrip('\n') + '\t(today, so far)')
    ev = read(os.path.join(LOG_DIR, 'events.tsv')).splitlines()[1:]
    print(f'\n# last {min(events, len(ev))} of {len(ev)} observed stall event(s)')
    for line in ev[-events:]:
        print(line)
    return 0


def selftest() -> int:
    checks = [
        (parse_go_duration('152.487957ms'), 0.152487957),
        (parse_go_duration('1m2.5s'), 62.5),
        (parse_go_duration('850µs'), 0.00085),
        (parse_go_duration('17.3s'), 17.3),
        (parse_go_duration('fast'), None),
        (etcd_slow_seconds('{"level":"warn","msg":"apply request took too long","took":"17.3s","expected-duration":"100ms"}'), 17.3),
        (etcd_slow_seconds('{"msg":"slow fdatasync","took":"1.2s","expected-duration":"1s"}'), 1.2),
        (etcd_slow_seconds('{"msg":"something else","took":"9s"}'), None),
        (classify_kernel_line('kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:'), 'rcu_stalls'),
        (classify_kernel_line('kernel: XFS (sdx): log I/O error -61'), 'fs_io_errors'),
        (classify_kernel_line('kernel:  connection129:0: detected conn error (1022)'), 'iscsi_conn_errors'),
        (classify_kernel_line("kernel: virtio_balloon virtio3: Out of puff! Can't get 1 pages"), 'balloon_out_of_puff'),
        (classify_kernel_line('kernel: INFO: task etcd:123 blocked for more than 120 seconds.'), 'hung_tasks'),
        (classify_kernel_line('kernel: eth0: link up'), None),
        (is_k3s_exit('systemd[1]: k3s.service: Main process exited, code=exited, status=1/FAILURE'), True),
        (is_k3s_exit('systemd[1]: k3s.service: Main process exited, code=exited, status=0/SUCCESS'), False),
        (is_k3s_exit('systemd[1]: k3s.service: Failed with result \'exit-code\'.'), False),
        (is_k3s_exit('systemd[1]: k3s.service: Main process exited, code=killed, status=9/KILL'), True),
        (cpu_pcts([0] * 8, [10, 0, 10, 70, 5, 0, 0, 5]), (5.0, 5.0)),
        (psi_avg60('some avg10=0.10 avg60=0.20 avg300=0.30 total=1\nfull avg10=0.01 avg60=0.02 avg300=0.03 total=1', 'full'), 0.02),
        (vmstat_fields('balloon_inflate 2621440\nballoon_deflate 7\nnr_free_pages 1', ('balloon_inflate', 'balloon_deflate')),
         {'balloon_inflate': 2621440, 'balloon_deflate': 7}),
    ]
    failed = 0
    for i, (got, want) in enumerate(checks):
        ok = (abs(got - want) < 1e-9) if isinstance(want, float) and isinstance(got, float) else got == want
        if not ok:
            failed += 1
            print(f'FAIL check {i}: got {got!r}, want {want!r}')
    print(f'selftest: {len(checks) - failed}/{len(checks)} passed')
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'run':
        return run()
    if cmd == 'report':
        n = int(argv[3]) if len(argv) > 3 and argv[2] == '--events' else 20
        return report(n)
    if cmd == 'summarize' and len(argv) > 2:
        os.makedirs(LOG_DIR, exist_ok=True)
        print(write_daily(dt.date.fromisoformat(argv[2]), 'probe'), end='')
        return 0
    if cmd == 'backfill' and len(argv) > 2:
        os.makedirs(LOG_DIR, exist_ok=True)
        today = utcnow().date()
        for back in range(int(argv[2]), 0, -1):
            write_daily(today - dt.timedelta(days=back), 'journal')
        return report(0)
    if cmd == 'selftest':
        return selftest()
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
