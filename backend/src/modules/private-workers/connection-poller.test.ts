import { describe, expect, it } from 'vitest';
import { frpsOnlinePorts } from './connection-poller.js';
import { buildFrpsToml, frpsConfigHash, frpsWebApiPassword } from './reconciler.js';

// Verbatim `GET /api/proxy/tcp` answers from frps v0.71.1 (the image the
// reconciler deploys), captured with a real frpc: connected, then stopped.
const ONLINE = {
  proxies: [{
    name: 'immich-test',
    conf: {
      name: 'immich-test', type: 'tcp', transport: { bandwidthLimit: '', bandwidthLimitMode: 'client' },
      loadBalancer: { group: '' }, healthCheck: { type: '', intervalSeconds: 0 }, localIP: '127.0.0.1', plugin: null, remotePort: 10000,
    },
    clientID: '6805846f18c0b08e', todayTrafficIn: 0, todayTrafficOut: 0, curConns: 0,
    lastStartTime: '10-28 20:55:36', lastCloseTime: '', status: 'online',
  }],
};
const OFFLINE = {
  proxies: [{
    name: 'immich-test', conf: null, clientID: '', todayTrafficIn: 0, todayTrafficOut: 0, curConns: 0,
    lastStartTime: '10-28 20:55:36', lastCloseTime: '10-28 20:56:12', status: 'offline',
  }],
};

describe('frpsOnlinePorts', () => {
  it('reads the remote port of an online proxy', () => {
    expect([...frpsOnlinePorts(ONLINE)]).toEqual([10000]);
  });

  it('reads nothing from a disconnected proxy — frps drops its config', () => {
    expect([...frpsOnlinePorts(OFFLINE)]).toEqual([]);
  });

  it('survives an answer of the wrong shape', () => {
    expect(frpsOnlinePorts(null).size).toBe(0);
    expect(frpsOnlinePorts({ proxies: 'x' }).size).toBe(0);
    expect(frpsOnlinePorts({ proxies: [{ status: 'online', conf: { remotePort: '10000' } }] }).size).toBe(0);
  });
});

describe('the frps config', () => {
  it('turns on the status API and keeps the port allowlist after the top-level keys', () => {
    const toml = buildFrpsToml('tok', [10000, 10001], 'pw');
    expect(toml).toContain('webServer.port = 7500');
    expect(toml).toContain('webServer.user = "platform"');
    expect(toml).toContain('webServer.password = "pw"');
    // TOML: a dotted key after a [[table]] would belong to the table.
    expect(toml.indexOf('webServer.password')).toBeLessThan(toml.indexOf('[[allowPorts]]'));
    expect(toml).toContain('[[allowPorts]]\nstart = 10001\nend = 10001');
  });

  it('★ a changed config changes the pod-template hash, so frps restarts onto it', () => {
    // frps cannot reload: without this a second worker's port never reached it.
    expect(frpsConfigHash(buildFrpsToml('tok', [10000], 'pw')))
      .not.toBe(frpsConfigHash(buildFrpsToml('tok', [10000, 10001], 'pw')));
    expect(frpsConfigHash(buildFrpsToml('tok', [10000], 'pw'))).toBe(frpsConfigHash(buildFrpsToml('tok', [10000], 'pw')));
  });

  it('derives the status password from the platform key, not from the tenant\'s token alone', () => {
    const prev = process.env.PLATFORM_ENCRYPTION_KEY;
    process.env.PLATFORM_ENCRYPTION_KEY = 'a'.repeat(64);
    const a = frpsWebApiPassword('t1', 'shared');
    process.env.PLATFORM_ENCRYPTION_KEY = 'b'.repeat(64);
    const b = frpsWebApiPassword('t1', 'shared');
    process.env.PLATFORM_ENCRYPTION_KEY = prev;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});
