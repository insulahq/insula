# stall-watch — temporary storage / vCPU stall recorder

Some VPS nodes stall for 8–48 seconds at a time: the guest is idle, then every
write to its disk waits for tens of seconds. etcd misses its deadlines (and,
with two members, the cluster loses quorum), Longhorn times out its replica,
salvages the volume and restarts the tenant's pods. The journal records the
damage, not the stall. `stall-watch` records the stall itself, with timestamps,
for a fixed period — evidence for a ticket to the hosting provider.

It is a **diagnostic, not part of the platform**: installed by hand on the nodes
being investigated, it stops recording on its own after the chosen number of
days and is not managed by host-migrations.

## Install / remove

```bash
# from a workstation, per node
scp -r scripts/stall-watch root@<node>:/root/stall-watch
ssh root@<node> '/root/stall-watch/install.sh --days 14 --backfill 14'

# remove (keeps the logs; --purge deletes them too)
ssh root@<node> '/root/stall-watch/uninstall.sh'
```

`--backfill 14` writes journal-only lines for the 14 days before the install,
so the table has a baseline from day one. Re-running `install.sh` re-arms the
deadline and keeps what was recorded.

## Read it

```bash
ssh root@<node> 'python3 /usr/local/lib/insula-stall-watch/stall-watch.py report --events 30'
```

Files in `/var/log/insula-stall-watch/`, all times UTC:

| File | One line per | What |
|------|--------------|------|
| `events.tsv` | observed stall | `fsync`: a 4 KiB write + `fdatasync` on the root filesystem took ≥ 1 s. `frozen`: the recorder's 1-second loop woke ≥ 2 s late — the process or the whole vCPU was not running. |
| `minutes.tsv` | minute | worst/mean fsync, worst lateness, memory-balloon inflate/deflate (KiB), CPU steal and iowait %, I/O and memory pressure (PSI full avg60), MemAvailable |
| `daily.tsv` | UTC day | the counts above plus the journal signatures of a stall (below) |

Daily columns from the journal: `etcd_slow_1s` / `etcd_max_s` (etcd "apply request
took too long" / "slow fdatasync" ≥ 1 s), `rcu_stalls`, `hung_tasks`,
`iscsi_conn_errors`, `fs_io_errors` (XFS log I/O errors, filesystem shutdowns,
ext4 errors), `balloon_out_of_puff`, `k3s_exits`, `longhorn_rw_timeouts`
(instance-manager container logs — rotated, so best effort). `source` is
`probe` for days the recorder ran, `journal` for backfilled days (probe columns `-`).

## Reading the evidence

- Only the probe columns (`fsync_*`, `frozen*`) are evidence about **this node's**
  own disk and vCPU. etcd is one cluster: when one member's disk stalls, every
  member logs slow applies, so `etcd_slow_1s` on a healthy node mostly reflects
  its peer.
- An `fsync` event **with** a `frozen` event at the same time: the vCPU stopped
  being scheduled — the hypervisor, not the disk alone.
- `fsync` **without** `frozen`: the guest ran, its disk did not answer — host
  storage.
- Balloon inflate/deflate in the minutes **before** an event, on a node whose
  CPU steal stays near zero, points at host memory reclaim.
- Stalls on one node only, at similar times of night, while the other node on
  the same provider is quiet, points at that node's host.

Footprint: one 4 KiB write per second to one file, about 3 MB of logs per 14 days,
under 30 MB of memory.
