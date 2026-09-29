/**
 * The traffic charts and the bandwidth meter both rest on which cAdvisor
 * network series survive the scrape. That survival is decided by two regexes
 * in `k8s/base/monitoring/scrape-config.yaml`, and both failure modes are
 * silent: narrow the keep and inbound quietly reads zero forever; widen the
 * drop and the node's own NIC disappears, taking per-node and cluster totals
 * with it. Neither shows up as an error — just an empty graph nobody can date.
 *
 * So the manifest is the fixture. These assertions are what the queries in
 * `promql.ts` assume about the data that reaches VictoriaMetrics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRAPE_CONFIG = fileURLToPath(
  new URL('../../../../k8s/base/monitoring/scrape-config.yaml', import.meta.url),
);

const yaml = readFileSync(SCRAPE_CONFIG, 'utf8');

/** Pull a `regex: '…'` out of the cadvisor job by the action that follows it. */
function cadvisorRegex(action: 'keep' | 'drop', mustContain: string): RegExp {
  const job = yaml.slice(yaml.indexOf('job_name: kubelet-cadvisor'), yaml.indexOf('job_name: kubelet-resource'));
  const found = [...job.matchAll(/regex: '([^']+)'\n\s+action: (keep|drop)/g)]
    .filter(([, re, act]) => act === action && re.includes(mustContain));
  expect(found, `no ${action} rule matching ${mustContain}`).toHaveLength(1);
  return new RegExp(`^(?:${found[0][1]})$`);
}

const keep = cadvisorRegex('keep', 'container_');
const drop = cadvisorRegex('drop', 'container_network_');

const kept = (name: string, iface: string): boolean =>
  keep.test(name) && !drop.test(`${name};${iface}`);

describe('cAdvisor keep list', () => {
  it('keeps BOTH directions — inbound is what the traffic tab adds', () => {
    expect(keep.test('container_network_transmit_bytes_total')).toBe(true);
    expect(keep.test('container_network_receive_bytes_total')).toBe(true);
  });

  it('still keeps what the SLO pack and the meter already read', () => {
    for (const m of ['container_memory_working_set_bytes', 'container_cpu_usage_seconds_total',
      'container_fs_usage_bytes', 'container_oom_events_total', 'machine_memory_bytes', 'machine_cpu_cores']) {
      expect(keep.test(m), m).toBe(true);
    }
  });

  it('does not open the floodgates', () => {
    for (const m of ['container_network_receive_packets_total', 'container_tasks_state',
      'container_spec_memory_limit_bytes', 'go_goroutines']) {
      expect(keep.test(m), m).toBe(false);
    }
  });
});

describe('interface drop list', () => {
  const NAME = 'container_network_receive_bytes_total';

  it('keeps a pod eth0 — this is the per-tenant billing series', () => {
    expect(kept(NAME, 'eth0')).toBe(true);
  });

  it('keeps a real NIC whatever the provider calls it', () => {
    // Hardcoding eth0 would lose node traffic on any host that names its NIC
    // differently, and the loss would be invisible — an empty graph, no error.
    // systemd predictable names (ens/enp/eno/enx), the older biosdevname
    // style (em1), bonds, VLAN sub-interfaces, and the bridge-as-primary
    // setups that Proxmox and libvirt hosts use must all survive.
    for (const nic of [
      'eth0', 'eth1', 'eth2',                      // classic
      'ens3', 'ens5', 'ens160', 'ens192',          // KVM / VMware
      'enp1s0', 'enp0s31f6', 'enp94s0f0',          // PCI slot naming
      'eno1', 'eno1np0', 'em1', 'p2p1',            // onboard / biosdevname
      'enx00e04c680125',                           // MAC-derived (USB NICs)
      'bond0', 'bond0.100', 'eth0.100', 'vlan200', // bonded / tagged
      'vmbr0', 'br0',                              // bridge as the primary NIC
      'ib0', 'net0',                               // InfiniBand / misc
    ]) {
      expect(kept(NAME, nic), nic).toBe(true);
    }
  });

  it('drops only the bridge shape Docker/CNI generates, never a host bridge', () => {
    // `br-<hex>` is Docker's per-network bridge; `br0`/`vmbr0` is somebody's
    // actual uplink. The hyphen is the whole difference, so it is asserted.
    expect(kept(NAME, 'br-1a2b3c4d5e6f')).toBe(false);
    expect(kept(NAME, 'br0')).toBe(true);
    expect(kept(NAME, 'vmbr0')).toBe(true);
  });

  it('keeps a mesh interface — that is real traffic over the underlay', () => {
    for (const nic of ['wt0', 'wg0', 'nb0']) expect(kept(NAME, nic), nic).toBe(true);
  });

  it('drops CNI plumbing, including Calico’s own encapsulation', () => {
    for (const v of ['cali0c0e0e9c695', 'calie7f2a1b3c4d', 'vxlan.calico', 'vxlan-v6.calico',
      'wireguard.cali', 'tunl0', 'veth9a2b', 'docker0', 'br-1a2b3c', 'flannel.1', 'cni0',
      'dummy0', 'nodelocaldns', 'kube-ipvs0', 'lo']) {
      expect(kept(NAME, v), v).toBe(false);
    }
  });

  it('leaves non-network metrics alone — the drop is scoped by __name__', () => {
    // The rule matches on [__name__, interface]; a metric with no interface
    // label joins as `name;` and must survive.
    expect(drop.test('container_memory_working_set_bytes;')).toBe(false);
    expect(drop.test('container_cpu_usage_seconds_total;')).toBe(false);
  });
});
