import { describe, expect, it } from 'vitest';
import type { ReleaseWorkloadChange } from '@insula/api-contracts';
import { deploymentsToRead, describeWorkload, upgradeWorkloads } from './workload-restarts.js';

const w = (kind: ReleaseWorkloadChange['kind'], namespace: string, name: string, change: ReleaseWorkloadChange['change'] = 'restart'): ReleaseWorkloadChange =>
  ({ kind, namespace, name, change });

const mail = w('Deployment', 'mail', 'stalwart-mail');
const webmail = w('Deployment', 'mail', 'bulwark');
const standby = w('DaemonSet', 'mail', 'mail-stack-standby-replicate');
const api = w('Deployment', 'platform', 'platform-api');
const db = w('Cluster', 'platform', 'system-db');
// 2026.10.8 → 2026.10.9, as scripts/release-workload-changes.py lists it for the real tags.
const table = { '2026.10.8': [standby, webmail, mail, w('Deployment', 'platform', 'admin-panel'), api, w('Deployment', 'platform', 'tenant-panel')] };

describe('upgradeWorkloads', () => {
  it('lists what the release restarts for the installed version, without the services the preview already reads', () => {
    const r = upgradeWorkloads(table, '2026.10.8');
    expect(r.known).toBe(true);
    expect(r.items.map((i) => i.name)).toEqual(['stalwart-mail', 'bulwark', 'mail-stack-standby-replicate']);
    expect(r.items.map((i) => i.label)).toEqual(['Mail server', 'Webmail (Bulwark)', 'Mail standby copy']);
  });

  it('is unknown — not "nothing restarts" — without a table, without the installed version in it, or for a development build', () => {
    expect(upgradeWorkloads(undefined, '2026.10.8')).toEqual({ known: false, items: [] });
    expect(upgradeWorkloads(table, '2026.9.1')).toEqual({ known: false, items: [] });
    expect(upgradeWorkloads(table, '2026.10.8-69ed428')).toEqual({ known: false, items: [] });
    expect(upgradeWorkloads(table, null)).toEqual({ known: false, items: [] });
  });

  it('an installed version the release lists with nothing to restart is known and empty', () => {
    expect(upgradeWorkloads({ '2026.10.8-rc.4': [api] }, '2026.10.8-rc.4')).toEqual({ known: true, items: [] });
  });

  it('does not read inherited object keys as versions', () => {
    expect(upgradeWorkloads(table, 'constructor').known).toBe(false);
    expect(upgradeWorkloads(table, '__proto__').known).toBe(false);
  });

  it('puts what users notice first: the mail server and the database, then webmail, then the reconcilers, then what starts or goes', () => {
    const order = upgradeWorkloads({
      '2026.10.8': [w('DaemonSet', 'platform-system', 'security-probe'), w('Deployment', 'x', 'gone', 'removed'),
        w('Deployment', 'x', 'fresh', 'added'), webmail, mail, db],
    }, '2026.10.8').items.map((i) => i.name);
    expect(order).toEqual(['stalwart-mail', 'system-db', 'bulwark', 'security-probe', 'fresh', 'gone']);
  });
});

describe('describeWorkload', () => {
  it("says what the mail server's restart does from its live strategy", () => {
    const recreate = describeWorkload(mail, { replicas: 1, strategy: { type: 'Recreate' } });
    expect(recreate.impact).toBe('one replica, stopped before its replacement starts — unavailable for ~30–90 s; '
      + 'no mail is received or sent meanwhile: sending servers retry, mail clients reconnect');
    expect(describeWorkload(mail, { replicas: 2 }).impact).toMatch(/^rolling restart — stays available via its other replica; no mail/);
  });

  it('a Deployment scaled to zero is not interrupted', () => {
    expect(describeWorkload(w('Deployment', 'mail', 'roundcube'), { replicas: 0, strategy: { type: 'RollingUpdate' } }))
      .toMatchObject({ label: 'Webmail (Roundcube)', impact: 'not running (scaled to zero), so nothing is interrupted' });
  });

  it('a Deployment whose spec could not be read just restarts — no guessed availability', () => {
    expect(describeWorkload(w('Deployment', 'monitoring', 'vmsingle'), undefined)).toMatchObject({ label: 'Metrics store', impact: 'restarts' });
  });

  it('names an unknown workload by name and namespace', () => {
    expect(describeWorkload(w('DaemonSet', 'platform', 'backup-rclone-shim'), undefined))
      .toMatchObject({ label: 'backup-rclone-shim (platform)', impact: 'one pod on each node, replaced node by node' });
  });

  it('the database says the primary restarts in place, and that tenant databases are not touched', () => {
    const d = describeWorkload(db, undefined);
    expect(d.label).toBe('Platform database');
    expect(d.impact).toMatch(/the primary restarts in place \(after any replicas\)/);
    expect(d.impact).toMatch(/Tenant databases are separate and keep running/);
  });

  it('a workload the release adds starts; one it drops is removed', () => {
    expect(describeWorkload(w('Deployment', 'mail', 'roundcube', 'added'), undefined).impact).toBe('new in this release — it starts');
    expect(describeWorkload(w('Deployment', 'mail', 'roundcube', 'removed'), undefined).impact).toBe('no longer part of the platform — it is removed');
  });
});

describe('deploymentsToRead', () => {
  it('reads only the restarted Deployments the preview does not already read', () => {
    expect(deploymentsToRead({ '2026.10.8': [...table['2026.10.8'], db, w('Deployment', 'mail', 'roundcube', 'added')] }, '2026.10.8')
      .map((d) => d.name)).toEqual(['bulwark', 'stalwart-mail']);
    expect(deploymentsToRead(table, '2026.1.1')).toEqual([]);
  });
});
