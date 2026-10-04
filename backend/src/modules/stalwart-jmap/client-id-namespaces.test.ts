/**
 * Account ids and domain ids are SEPARATE sequences in Stalwart 0.16, and they
 * collide: on a running install every domain id is also some account's id.
 *
 * The principal shims used to send an id to x:Account first and to x:Domain
 * only when x:Account said notFound. Given a domain id, x:Account found the
 * colliding MAILBOX — so "destroy this domain" destroyed someone's mailbox
 * (another tenant's, the webmail master user…) and left the domain in place,
 * and the DKIM status read the mailbox's (absent) zone file for every domain.
 *
 * This fake Stalwart holds a mailbox and a domain under the SAME id and checks
 * that every operation lands in the namespace it names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  destroyDomain,
  destroyPrincipal,
  getDomainDnsZoneFile,
  principalGetOne,
  updatePrincipal,
  createDomain,
} from './client.js';

const BASE_URL = 'http://stalwart-test:8080';
const TEST_ENV: NodeJS.ProcessEnv = { STALWART_ADMIN_USER: 'admin', STALWART_ADMIN_PASSWORD: 'test-password' };
const ACCOUNT_ID = 'p333333333333';
const ZONE = 'example.test. IN MX 10 mail.example.test.\ndkim-1._domainkey.example.test. IN TXT "v=DKIM1; k=rsa; p=AAAA"';

let accounts: Map<string, Record<string, unknown>>;
let domains: Map<string, Record<string, unknown>>;
let calls: string[];

function handle(method: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = method.startsWith('x:Account/') ? accounts : method.startsWith('x:Domain/') ? domains : null;
  if (!store) throw new Error(`unexpected method ${method}`);
  if (method.endsWith('/get')) {
    const ids = (args.ids as string[] | null) ?? [...store.keys()];
    return {
      accountId: ACCOUNT_ID, state: 's1',
      list: ids.filter((id) => store.has(id)).map((id) => ({ id, ...store.get(id) })),
      notFound: ids.filter((id) => !store.has(id)),
    };
  }
  // /set
  const destroyed: string[] = [];
  const notDestroyed: Record<string, { type: string }> = {};
  for (const id of (args.destroy as string[] | undefined) ?? []) {
    if (store.delete(id)) destroyed.push(id); else notDestroyed[id] = { type: 'notFound' };
  }
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, { type: string }> = {};
  for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
    if (store.has(id)) { store.set(id, { ...store.get(id), ...patch }); updated[id] = null; } else notUpdated[id] = { type: 'notFound' };
  }
  const created: Record<string, { id: string }> = {};
  for (const [k, v] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
    const id = `new-${k}`;
    store.set(id, v);
    created[k] = { id, ...v };
  }
  return {
    accountId: ACCOUNT_ID, oldState: 's1', newState: 's2',
    created: Object.keys(created).length ? created : null,
    updated: Object.keys(updated).length ? updated : null,
    destroyed: destroyed.length ? destroyed : null,
    notCreated: null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

beforeEach(() => {
  accounts = new Map([['g', { name: 'victim', '@type': 'User', domainId: 'h' }]]);
  domains = new Map([['g', { name: 'example.test', dnsZoneFile: ZONE }], ['h', { name: 'other.test', dnsZoneFile: '' }]]);
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
    const req = JSON.parse(init.body ?? '{}') as { methodCalls: Array<[string, Record<string, unknown>, string]> };
    const methodResponses = req.methodCalls.map(([method, args, callId]) => {
      calls.push(method);
      return [method, handle(method, args), callId];
    });
    const payload = { methodResponses, sessionState: 's1' };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload), json: async () => payload };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const common = { accountId: ACCOUNT_ID, baseUrl: BASE_URL, env: TEST_ENV };

describe('a domain id that is also an account id', () => {
  it('destroyDomain removes the DOMAIN and leaves the mailbox that shares its id', async () => {
    await destroyDomain({ ...common, id: 'g' });
    expect(domains.has('g')).toBe(false);
    expect(accounts.has('g')).toBe(true);
    expect(calls).toEqual(['x:Domain/set']);
  });

  it('destroyDomain reports a refusal instead of claiming success', async () => {
    await expect(destroyDomain({ ...common, id: 'missing' })).rejects.toThrow(/Failed to destroy domain 'missing'/);
  });

  it('the DKIM zone file is read from the DOMAIN', async () => {
    expect(await getDomainDnsZoneFile({ ...common, domainPrincipalId: 'g' })).toBe(ZONE);
    expect(calls).toEqual(['x:Domain/get']);
  });

  it('an empty zone file reads as not available, not as an empty string', async () => {
    expect(await getDomainDnsZoneFile({ ...common, domainPrincipalId: 'h' })).toBeNull();
  });
});

describe('the account shims never fall through to x:Domain', () => {
  it('principalGetOne by id returns the ACCOUNT, and a miss is a miss', async () => {
    expect((await principalGetOne({ ...common, id: 'g' }))?.name).toBe('victim');
    expect(await principalGetOne({ ...common, id: 'h' })).toBeNull(); // only a domain has id h
    expect(calls.filter((c) => c === 'x:Domain/get')).toEqual([]);
  });

  it('destroyPrincipal of an id only domains have destroys nothing', async () => {
    await expect(destroyPrincipal({ ...common, id: 'h' })).rejects.toThrow(/notFound/);
    expect(domains.has('h')).toBe(true);
    expect(calls).not.toContain('x:Domain/set');
  });

  it('updatePrincipal of a stale account id does not patch the domain that shares it', async () => {
    accounts.delete('g');
    await expect(updatePrincipal({ ...common, id: 'g', patch: { permissions: {} } })).rejects.toThrow(/notFound/);
    expect(domains.get('g')).not.toHaveProperty('permissions');
    expect(calls).not.toContain('x:Domain/set');
  });

  it('domain creation still goes to x:Domain', async () => {
    const created = await createDomain({ ...common, input: { type: 'domain', name: 'new.test' } });
    expect(created.id).toBeTruthy();
    expect(calls).toContain('x:Domain/set');
  });
});

// ── No caller hands a DOMAIN id to an account helper ─────────────────────────
// The two destructive call sites that did (email-domain teardown, Data Drift
// "delete orphan domain") are the reason this file exists.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('callers keep the namespaces apart', () => {
  const SRC = join(import.meta.dirname, '..', '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
  /** Each `fn({ … })` call's argument object, braces balanced (strings skipped). */
  function callArgs(src: string, fn: RegExp): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(fn)) {
      let i = (m.index ?? 0) + m[0].length; // just past the opening "{"
      let depth = 1;
      let quote: string | null = null;
      const start = i;
      for (; i < src.length && depth > 0; i += 1) {
        const ch = src[i];
        if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      out.push(src.slice(start, i - 1));
    }
    return out;
  }
  const ACCOUNT_HELPER = /\b(destroyPrincipal|jmapDestroyPrincipal|updatePrincipal|principalGetOne|principalGet|principalSet)\(\{/g;
  const DOMAIN_ID = /domainId|DomainId|domainPrincipalId/;

  it('the scanner sees past nested objects and covers every account helper', () => {
    const tricky = 'updatePrincipal({\n  accountId,\n  patch: { foo: 1 },\n  id: emailDomain.stalwartDomainId,\n});\n'
      + 'principalGet({ accountId, ids: [emailDomain.stalwartDomainId] });';
    expect(callArgs(tricky, ACCOUNT_HELPER).filter((a) => DOMAIN_ID.test(a))).toHaveLength(2);
  });

  it('no account helper is called with a domain id', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith('stalwart-jmap/client.ts')) continue; // the helpers themselves
      for (const args of callArgs(readFileSync(f, 'utf8'), ACCOUNT_HELPER)) {
        if (DOMAIN_ID.test(args)) offenders.push(`${f.slice(SRC.length + 1)}: ${args.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
