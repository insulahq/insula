/**
 * The pass as a whole: probe, look again a minute later, and only then tell
 * anyone — naming what failed.
 *
 * Production sent "[MAIL] deliverability check failing … Mail delivery is
 * likely affected" three times in a week. Each was ONE failing pass out of
 * about a hundred, gone by the next; the alert named no check, and nothing
 * recorded which one it had been. The pure rules are pinned in
 * health-scheduler.test.ts; this file pins that the pass actually applies them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';

const state = vi.hoisted(() => ({
  healths: [] as Array<{ healthy: boolean; components: Record<string, unknown> } | Error>,
  probes: 0,
  notified: [] as Array<{ payload: Record<string, unknown>; dedupeKey: string | undefined }>,
  notices: [] as Array<{ subsystem: string; payload: Record<string, unknown>; dedupeKey: string | undefined; resourceType?: string }>,
  holds: new Map<string, { until: Date; reason: string }>(),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: () => ({}) }));
vi.mock('../webmail-settings/service.js', () => ({
  getWebmailSettings: async () => ({ mailServerHostname: 'mail.example.test' }),
}));
vi.mock('./credentials.js', () => ({ readStalwartCredentials: () => ({ username: 'admin', password: 'x' }) }));
vi.mock('./mail-endpoints.js', () => ({ resolveMailEndpoints: async () => ({ mode: 'allServerNodes', endpoints: [] }) }));
vi.mock('./health-capacity.js', () => ({ mailCapacityReader: () => async () => ({}), capacityItems: () => [] }));
vi.mock('./health.js', () => ({
  getMailHealth: async () => {
    const next = state.healths[Math.min(state.probes, state.healths.length - 1)];
    state.probes += 1;
    if (next instanceof Error) throw next;
    return next;
  },
}));
vi.mock('../node-health/outage-hold.js', () => ({ lazyNodeAlertHolds: () => async () => state.holds }));
vi.mock('../notifications/events.js', () => ({
  notifyAdminMailHealthDegraded: async (_db: unknown, payload: Record<string, unknown>, dedupeKey?: string) => {
    state.notified.push({ payload, dedupeKey });
  },
  notifyAdminOperationalEvent: async (_db: unknown, subsystem: string, payload: Record<string, unknown>, dedupeKey?: string, resourceType?: string) => {
    state.notices.push({ subsystem, payload, dedupeKey, resourceType });
  },
}));

const {
  runMailHealthCheckOnce, resetUnansweredStreak, CONFIRM_AFTER_MS, UNANSWERED_NOTICE_AFTER_PASSES,
} = await import('./health-scheduler.js');

const db = {} as Database;
const NOON = () => Date.parse('2026-10-13T11:19:13Z');
const logSpy = () => ({ info: vi.fn(), warn: vi.fn() });
const text = (calls: unknown[][]) => calls.map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n');

const healthy = { healthy: true, components: { pod: { healthy: true }, deliverability: { healthy: true } } };
const ptrFails = (ip: string) => ({
  healthy: false,
  components: {
    pod: { healthy: true },
    deliverability: {
      healthy: false,
      error: '1 deliverability failure — open Details to inspect',
      reverseDns: [{ severity: 'fail', ip, node: 'node-b', actual: '(no records)' }],
    },
  },
});

/** Run one pass; `waits` records every pause the pass asked for. */
async function pass(healths: typeof state.healths, log = logSpy()) {
  state.healths = healths;
  const waits: number[] = [];
  const fired = await runMailHealthCheckOnce(db, log, undefined, NOON, async (ms) => { waits.push(ms); });
  return { fired, waits, log };
}

describe('mail health pass: look twice before telling anyone', () => {
  beforeEach(() => { state.probes = 0; state.notified = []; state.notices = []; resetUnansweredStreak(); });

  it('a healthy pass probes once, waits for nothing and says nothing', async () => {
    const { fired, waits } = await pass([healthy]);
    expect({ fired, probes: state.probes, waits, notified: state.notified.length }).toEqual({ fired: 0, probes: 1, waits: [], notified: 0 });
  });

  it('one failing pass that is fine a minute later is NOT alerted (the production false alarm)', async () => {
    const { fired, waits, log } = await pass([ptrFails('198.51.100.11'), healthy]);
    expect(fired).toBe(0);
    expect(state.notified).toEqual([]);
    // It did look again — after the confirmation delay, not straight away.
    expect(state.probes).toBe(2);
    expect(waits).toEqual([CONFIRM_AFTER_MS]);
    // ...and it leaves a trace of what it saw, instead of nothing at all.
    expect(text(log.info.mock.calls)).toMatch(/failure gone on the second look/);
    expect(text(log.info.mock.calls)).toContain('deliverability');
  });

  it('a failure still there a minute later IS alerted, and the alert names the check and the address', async () => {
    const { fired, log } = await pass([ptrFails('198.51.100.11'), ptrFails('198.51.100.11')]);
    expect(fired).toBe(1);
    expect(state.notified).toHaveLength(1);
    const { payload, dedupeKey } = state.notified[0]!;
    expect(payload).toMatchObject({
      component: 'deliverability',
      mailHostname: 'mail.example.test',
      detail: ' 1 failing check:',
      items: ['reverse DNS for 198.51.100.11 (node-b): (no records)'],
      impact: 'Mail delivery is likely affected.',
    });
    expect(dedupeKey).toBe('mail-health:deliverability:2026-10-13:am');
    // What failed is in the log too: the alert used to be the only record, and it named nothing.
    expect(text(log.info.mock.calls)).toContain('reverse DNS for 198.51.100.11 (node-b)');
  });

  it('two different checks failing once each are two blips, not a fault', async () => {
    const { fired } = await pass([ptrFails('198.51.100.10'), ptrFails('198.51.100.11')]);
    expect(fired).toBe(0);
    expect(state.notified).toEqual([]);
  });

  it('a mail server that is down both times is alerted with its own reason', async () => {
    const down = { healthy: false, components: { pod: { healthy: false, error: 'no Running pod' } } };
    const { fired } = await pass([down, down]);
    expect(fired).toBe(1);
    expect(state.notified[0]!.payload).toMatchObject({ component: 'Stalwart pod', detail: ' no Running pod', items: [] });
  });

  // A standby that is behind is not an outage: the alert used to end with
  // "Mail delivery is likely affected" for it too.
  it('a failing standby copy says delivery is not affected, and what is at stake', async () => {
    const behind = { healthy: false, components: { pod: { healthy: true }, standby: { healthy: false, error: '1 standby node has no copy younger than 30 min.' } } };
    const { fired } = await pass([behind, behind]);
    expect(fired).toBe(1);
    expect(state.notified[0]!.payload).toMatchObject({
      component: 'standby mail copy',
      impact: 'Mail delivery is not affected.',
    });
  });

  it('caps a long list of failing checks instead of sending forty lines', async () => {
    const many = {
      healthy: false,
      components: {
        deliverability: {
          healthy: false,
          error: '40 deliverability failures',
          blocklists: Array.from({ length: 40 }, (_, i) => ({ severity: 'fail', ip: `198.51.100.${i}`, list: 'SpamCop' })),
        },
      },
    };
    await pass([many, many]);
    const { items, detail } = state.notified[0]!.payload as { items: string[]; detail: string };
    expect(items).toHaveLength(13);
    expect(items[12]).toBe('…and 28 more.');
    // The sentence counts what failed, not what was listed.
    expect(detail).toBe(' 40 failing checks:');
  });

  it('a second look that cannot be made confirms nothing: no alert, no throw, and it says so', async () => {
    const { fired, log } = await pass([ptrFails('198.51.100.11'), new Error('etcdserver: request timed out')]);
    expect(fired).toBe(0);
    expect(state.notified).toEqual([]);
    expect(text(log.warn.mock.calls)).toMatch(/second look failed to run/);
    expect(text(log.warn.mock.calls)).toContain('deliverability');
  });
});

describe('mail health pass: lookups that get no answer', () => {
  beforeEach(() => { state.probes = 0; state.notified = []; state.notices = []; resetUnansweredStreak(); });

  const unanswered = {
    healthy: true,
    components: {
      deliverability: {
        healthy: true,
        forwardDns: { severity: 'ok', actual: '198.51.100.11' },
        reverseDns: [{ severity: 'skipped', ip: '198.51.100.11', node: 'node-b', actual: 'lookup got no answer: queryPtr ETIMEOUT' }],
      },
    },
  };

  it('one pass: no alert, no second look — but it is logged, by name', async () => {
    const { fired, waits, log } = await pass([unanswered]);
    expect({ fired, waits, alerts: state.notified.length, notices: state.notices.length }).toEqual({ fired: 0, waits: [], alerts: 0, notices: 0 });
    expect(text(log.warn.mock.calls)).toMatch(/1 DNS lookup\(s\) got no answer/);
    expect(text(log.warn.mock.calls)).toContain('reverse DNS for 198.51.100.11 (node-b)');
  });

  it('an hour of it is reported — as checks NOT MADE, never as mail being affected', async () => {
    for (let i = 1; i < UNANSWERED_NOTICE_AFTER_PASSES; i += 1) {
      state.probes = 0;
      await pass([unanswered]);
      expect(state.notices).toEqual([]);
    }
    state.probes = 0;
    await pass([unanswered]);
    expect(state.notices).toHaveLength(1);
    const { subsystem, payload, dedupeKey, resourceType } = state.notices[0]!;
    expect(subsystem).toBe('mail');
    // Opens Monitoring → Mail, where the deliverability checks are shown.
    expect(resourceType).toBe('mail_monitoring');
    expect(payload).toMatchObject({
      subsystem: 'Mail deliverability checks',
      objectLabel: 'mail.example.test',
      severityLabel: 'not checked',
      items: ['reverse DNS for 198.51.100.11 (node-b)'],
    });
    expect(String(payload.detail)).toMatch(/no answer on 4 passes in a row/);
    expect(String(payload.detail)).toMatch(/says nothing about the records/);
    // Twice a day at most, like every other mail-health alert.
    expect(dedupeKey).toBe('mail-health:unanswered:2026-10-13:am');
    // And it is not the "check is FAILING / delivery likely affected" alert.
    expect(state.notified).toEqual([]);
  });

  it('one answered pass starts the count again', async () => {
    for (let i = 1; i < UNANSWERED_NOTICE_AFTER_PASSES; i += 1) { state.probes = 0; await pass([unanswered]); }
    state.probes = 0;
    await pass([healthy]);
    for (let i = 1; i < UNANSWERED_NOTICE_AFTER_PASSES; i += 1) { state.probes = 0; await pass([unanswered]); }
    expect(state.notices).toEqual([]);
  });
});

// Production, a server shut down on purpose: "[MAIL] mail port exposure check
// failing … <node>: no stalwart-haproxy pod runs here — … re-apply the
// port-exposure mode", minutes after that server was announced as down.
describe('mail health pass: an endpoint on a node that is down', () => {
  beforeEach(() => { state.probes = 0; state.notified = []; state.notices = []; state.holds = new Map(); resetUnansweredStreak(); });

  const endpoint = (node: string, error: string | null) => ({ node, exposure: 'haproxy', ready: error === null, ports: [], error });
  const exposure = (...nodes: ReturnType<typeof endpoint>[]) => {
    const bad = nodes.filter((n) => n.error !== null);
    return {
      healthy: false,
      components: {
        pod: { healthy: true },
        exposure: {
          status: 'fail',
          healthy: false,
          nodes,
          error: `${bad.length}/${nodes.length} mail endpoint(s) not publishing every mail port: ${bad.map((n) => `${n.node}: ${n.error}`).join('; ')}`,
        },
      },
    };
  };
  const down = (node: string) => state.holds.set(node, { until: new Date('2026-10-13T11:29:13Z'), reason: 'node-down' });

  it('is not alerted while the node is down — the node\'s own notice told the operator', async () => {
    down('node-b');
    const failing = exposure(endpoint('node-a', null), endpoint('node-b', 'no stalwart-haproxy pod runs here'));
    const { fired, log } = await pass([failing, failing]);
    expect(fired).toBe(0);
    expect(state.notified).toEqual([]);
    expect(text(log.info.mock.calls)).toContain('node-b is down — mail port exposure alert suppressed while it is down');
  });

  it('still alerts the endpoints that are not on a held node, and names only those', async () => {
    down('node-b');
    const failing = exposure(
      endpoint('node-a', 'the stalwart-haproxy pod here is not Ready'),
      endpoint('node-b', 'no stalwart-haproxy pod runs here'),
      endpoint('node-c', null),
    );
    const { fired } = await pass([failing, failing]);
    expect(fired).toBe(1);
    expect(state.notified[0]!.payload).toMatchObject({
      component: 'mail port exposure',
      detail: ' 1/3 mail endpoint(s) not publishing every mail port: node-a: the stalwart-haproxy pod here is not Ready',
    });
    // Keyed by the endpoints it names: node-b, still failing once its hold
    // ends, is news in this same 12-hour bucket — not a duplicate of this.
    expect(state.notified[0]!.dedupeKey).toBe('mail-health:exposure:2026-10-13:am:node-a');
    state.holds = new Map();
    state.probes = 0;
    await pass([failing, failing]);
    expect(state.notified[1]!.dedupeKey).toBe('mail-health:exposure:2026-10-13:am:node-a,node-b');
  });

  it('alerts as before when no node is held', async () => {
    const failing = exposure(endpoint('node-a', null), endpoint('node-b', 'no stalwart-haproxy pod runs here'));
    const { fired } = await pass([failing, failing]);
    expect(fired).toBe(1);
    expect(String(state.notified[0]!.payload.detail)).toContain('node-b: no stalwart-haproxy pod runs here');
  });

  it('does not hold the mail server itself — a Stalwart pod down with its node is mail being down', async () => {
    down('node-b');
    const failing = {
      healthy: false,
      components: {
        pod: { healthy: false, error: 'no Running pod' },
        exposure: exposure(endpoint('node-b', 'no Stalwart pod is running here (see the pod probe)')).components.exposure,
      },
    };
    const { fired } = await pass([failing, failing]);
    expect(fired).toBe(1);
    expect(state.notified.map((n) => n.payload.component)).toEqual(['Stalwart pod']);
  });
});
