import { describe, it, expect } from 'vitest';
import { decodeSnapshot } from './ssh-probe.js';

describe('decodeSnapshot', () => {
  const baseRaw = {
    nodeName: 'node-a',
    generatedAt: '2026-05-18T10:00:00Z',
    mesh: {
      provider: 'netbird',
      interfaceName: 'wt0',
      interfaceIp: '100.64.0.1',
      peerCount: 3,
      lastHandshakeAgeSeconds: 12,
    },
    ssh: {
      restrictionMode: 'mesh-and-trusted',
      sshViaMeshFlag: true,
      enforcedInterface: 'wt0',
      sshdFlags: {
        permitRootLogin: 'no',
        passwordAuthentication: 'no',
        kbdInteractiveAuthentication: 'no',
        allowUsers: ['admin'],
        port: 22,
        configSha256: 'a'.repeat(64),
      },
      parseSucceeded: true,
      parseError: null,
    },
    hardening: {
      kernelVersion: '6.1.0-21-amd64',
      kernelEol: false,
      timeSinceRebootSeconds: 3600,
      pendingKernelUpdate: false,
      fail2banPresent: true,
      sshguardPresent: false,
      unattendedUpgradesActive: true,
      automaticRebootWindow: '02:00-04:00',
      osPretty: 'Debian GNU/Linux 12 (bookworm)',
      cisFindings: [
        { id: 'SSH-001', severity: 'high', title: 't', observed: 'no', expected: 'no', passing: true },
      ],
    },
    publicPortsV4: { tcp: [80, 443], udp: [51820, 51821] },
  };

  it('decodes a full snapshot', () => {
    const snap = decodeSnapshot('node-a', baseRaw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:01:00Z'));
    expect(snap.name).toBe('node-a');
    expect(snap.mesh.provider).toBe('netbird');
    expect(snap.mesh.peerCount).toBe(3);
    expect(snap.ssh.restrictionMode).toBe('mesh-and-trusted');
    expect(snap.ssh.sshViaMeshFlag).toBe(true);
    expect(snap.ssh.sshdFlags.allowUsers).toEqual(['admin']);
    expect(snap.hardening.cisFindings).toHaveLength(1);
    expect(snap.stale).toBe(false);
  });

  it('marks stale when lastUpdatedAt is null', () => {
    const snap = decodeSnapshot('node-a', baseRaw, null, new Date('2026-05-18T10:00:00Z'));
    expect(snap.stale).toBe(true);
    expect(snap.lastUpdatedAt).toBeNull();
  });

  it('marks stale when lastUpdatedAt is older than 5 minutes', () => {
    const snap = decodeSnapshot('node-a', baseRaw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:10:00Z'));
    expect(snap.stale).toBe(true);
  });

  it('defaults provider to none when probe sends an unknown value', () => {
    const snap = decodeSnapshot('node-a', { ...baseRaw, mesh: { ...baseRaw.mesh, provider: 'magic-mesh-9000' } }, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:00:30Z'));
    expect(snap.mesh.provider).toBe('none');
  });

  it('defaults restrictionMode to public when probe sends an unknown value', () => {
    const snap = decodeSnapshot('node-a', { ...baseRaw, ssh: { ...baseRaw.ssh, restrictionMode: 'magic-mode' } }, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:00:30Z'));
    expect(snap.ssh.restrictionMode).toBe('public');
  });

  it('falls back to port 22 when probe sshd_config parse failed', () => {
    const raw = {
      ...baseRaw,
      ssh: { ...baseRaw.ssh, parseSucceeded: false, sshdFlags: { port: undefined } },
    };
    const snap = decodeSnapshot('node-a', raw as unknown as typeof baseRaw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:00:30Z'));
    expect(snap.ssh.sshdFlags.port).toBe(22);
    expect(snap.ssh.parseSucceeded).toBe(false);
  });

  it('coerces unknown CIS severities to info', () => {
    const raw = {
      ...baseRaw,
      hardening: {
        ...baseRaw.hardening,
        cisFindings: [
          { id: 'X-001', severity: 'apocalypse', title: 't', observed: 'o', expected: 'e', passing: false },
        ],
      },
    };
    const snap = decodeSnapshot('node-a', raw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:00:30Z'));
    expect(snap.hardening.cisFindings[0].severity).toBe('info');
  });

  it('parses fail2ban data when the probe reports it', () => {
    const raw = {
      ...baseRaw,
      fail2ban: {
        dbPresent: true,
        readError: null,
        currentlyBanned: [
          { ip: '203.0.113.10', jail: 'sshd', bannedAt: '2026-06-05T10:00:00Z', expiresAt: '2026-06-05T11:00:00Z', banCount: 2 },
          { ip: '198.51.100.7', jail: 'sshd', bannedAt: '2026-06-02T10:00:00Z', expiresAt: null, banCount: 9 },
        ],
        bannedNowCount: 2,
        bansLast24h: 5,
        bansTotal: 1949,
      },
    };
    const snap = decodeSnapshot('node-a', raw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:01:00Z'));
    expect(snap.fail2ban.dbPresent).toBe(true);
    expect(snap.fail2ban.bannedNowCount).toBe(2);
    expect(snap.fail2ban.bansLast24h).toBe(5);
    expect(snap.fail2ban.bansTotal).toBe(1949);
    expect(snap.fail2ban.currentlyBanned[0].ip).toBe('203.0.113.10');
    expect(snap.fail2ban.currentlyBanned[1].expiresAt).toBeNull(); // permanent
  });

  it('falls back to the FAIL2BAN_ABSENT sentinel for pre-upgrade probe payloads', () => {
    const snap = decodeSnapshot('node-a', baseRaw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:01:00Z'));
    expect(snap.fail2ban.dbPresent).toBe(false);
    expect(snap.fail2ban.readError).toMatch(/pre-upgrade probe/);
    expect(snap.fail2ban.currentlyBanned).toEqual([]);
  });

  it('drops malformed banned entries and clamps negatives', () => {
    const raw = {
      ...baseRaw,
      fail2ban: {
        dbPresent: true,
        readError: null,
        currentlyBanned: [
          { ip: '', jail: 'sshd', bannedAt: null, expiresAt: null, banCount: 1 },
          { ip: '203.0.113.99', banCount: -4 },
        ],
        bannedNowCount: 1,
        bansLast24h: 0,
        bansTotal: 1,
      },
    };
    const snap = decodeSnapshot('node-a', raw, '2026-05-18T10:00:00Z', new Date('2026-05-18T10:01:00Z'));
    expect(snap.fail2ban.currentlyBanned).toHaveLength(1);
    expect(snap.fail2ban.currentlyBanned[0]).toEqual({
      ip: '203.0.113.99', jail: 'sshd', bannedAt: null, expiresAt: null, banCount: 0,
    });
  });
});
