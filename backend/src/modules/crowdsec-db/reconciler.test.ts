import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  buildCrowdsecDbSql,
  ensureDbSecret,
  psqlSetVar,
  CROWDSEC_DB_SECRET,
  CROWDSEC_NAMESPACE,
} from './reconciler.js';

type Core = Parameters<typeof ensureDbSecret>[0];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('buildCrowdsecDbSql', () => {
  it('never embeds the password in the SQL text', () => {
    // The password is threaded in as a psql variable (-v cspw=…) and referenced
    // as :'cspw', which psql substitutes as a quoted literal and quote_literal()
    // quotes again server-side. If it ever appears here directly, an operator
    // password containing a quote becomes SQL injection against the platform's
    // own database.
    const sql = buildCrowdsecDbSql();
    expect(sql).toContain(":'cspw'");
    // EVERY mention of PASSWORD must hand off to quote_literal(:'cspw') and
    // nothing else — no concatenated value, no interpolated variable.
    const mentions = sql.match(/PASSWORD[^\n]*/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const m of mentions) {
      expect(m, m).toContain("quote_literal(:'cspw')");
    }
  });

  it('is idempotent by construction — ALTER when the role exists, CREATE when not', () => {
    const sql = buildCrowdsecDbSql();
    expect(sql).toContain('ALTER ROLE crowdsec');
    expect(sql).toContain('CREATE ROLE crowdsec');
    expect(sql).toContain('WHERE NOT EXISTS (SELECT FROM pg_database');
  });
});

describe('ensureDbSecret', () => {
  it('generates and stores a password when the Secret is absent', async () => {
    const create = vi.fn().mockResolvedValue({});
    const core = {
      readNamespacedSecret: vi.fn().mockRejectedValue(new Error('not found')),
      createNamespacedSecret: create,
      replaceNamespacedSecret: vi.fn(),
    } as unknown as Core;

    const r = await ensureDbSecret(core, log);
    expect(r?.created).toBe(true);
    const body = create.mock.calls[0][0].body;
    expect(body.metadata.namespace).toBe(CROWDSEC_NAMESPACE);
    expect(body.metadata.name).toBe(CROWDSEC_DB_SECRET);
    // Everything the init container needs, or it silently stays on SQLite.
    for (const k of ['host', 'port', 'dbname', 'username', 'password', 'sslmode']) {
      expect(body.stringData[k], k).toBeTruthy();
    }
    expect(body.stringData.sslmode).toBe('require');
    // 32 CSPRNG bytes, base64url — long enough that a leaked hash is not worth grinding.
    expect(body.stringData.password.length).toBeGreaterThanOrEqual(40);
  });

  it('NEVER regenerates an existing password', async () => {
    // The LAPI reads it at pod start. Rotating it here without restarting the
    // pod would leave a running LAPI authenticating with a password Postgres
    // no longer accepts — a self-inflicted outage on every 5-minute tick.
    const create = vi.fn();
    const replace = vi.fn();
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue({ data: { password: b64('existing-pw') } }),
      createNamespacedSecret: create,
      replaceNamespacedSecret: replace,
    } as unknown as Core;

    const r = await ensureDbSecret(core, log);
    expect(r).toEqual({ password: 'existing-pw', created: false });
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('repairs a Secret that exists but has no password key, WITH resourceVersion', async () => {
    // Kubernetes rejects a replace without metadata.resourceVersion
    // ("must be specified for an update"). Asserting only that replace was
    // CALLED passes against code that could never succeed against a real
    // cluster — which is exactly what the first version of this did.
    const replace = vi.fn().mockResolvedValue({});
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue({
        data: { host: b64('x') },
        metadata: { resourceVersion: '12345' },
      }),
      createNamespacedSecret: vi.fn(),
      replaceNamespacedSecret: replace,
    } as unknown as Core;

    const r = await ensureDbSecret(core, log);
    expect(r?.created).toBe(true);
    expect(replace.mock.calls[0][0].body.metadata.resourceVersion).toBe('12345');
  });

  it('re-reads rather than inventing a password when another replica wins the race', async () => {
    // HA runs platform-api at 2-3 replicas. If each kept its own generated
    // value, one would write a password to Postgres that the other's Secret
    // does not contain, and the LAPI would authenticate with the wrong one.
    const conflict = Object.assign(new Error('already exists'), { statusCode: 409 });
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ data: { password: b64('winner-pw') } });
    const core = {
      readNamespacedSecret: read,
      createNamespacedSecret: vi.fn().mockRejectedValue(conflict),
      replaceNamespacedSecret: vi.fn(),
    } as unknown as Core;

    const r = await ensureDbSecret(core, log);
    expect(r).toEqual({ password: 'winner-pw', created: false });
  });

  it('returns null rather than a half-provisioned state on a non-conflict failure', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockRejectedValue(new Error('not found')),
      createNamespacedSecret: vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 })),
      replaceNamespacedSecret: vi.fn(),
    } as unknown as Core;
    expect(await ensureDbSecret(core, log)).toBeNull();
  });
});

describe('psqlSetVar', () => {
  it('emits a psql \\set line for a normal generated password', () => {
    expect(psqlSetVar('cspw', 'AbC-123_xyz')).toBe("\\set cspw 'AbC-123_xyz'");
  });

  it('REFUSES a value that could break out of the psql meta-command', () => {
    // The password reaches psql over stdin as `\set cspw '<value>'`. A quote or
    // backslash would escape that literal. Generated passwords are base64url
    // and cannot contain either, but the guard must not depend on that
    // remaining true — reject rather than mangle.
    for (const bad of ["pw'; DROP", 'pw\\x', 'pw with space', 'pw\nnewline', '']) {
      expect(() => psqlSetVar('cspw', bad), JSON.stringify(bad)).toThrow();
    }
  });
});
