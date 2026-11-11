import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { DnsLike } from '../dns-resolver/service.js';
import { ApiError } from '../../shared/errors.js';
import { assertDnsControlForMail, mxPointsAt } from './dns-control.js';

const db = {} as Database;
const MAIL_HOST = 'mail.platform.example.test';

function resolverWithMx(exchanges: string[] | Error): DnsLike {
  return {
    resolve4: vi.fn(), resolve6: vi.fn(), resolveNs: vi.fn(), resolveCname: vi.fn(),
    resolveMx: vi.fn(async () => {
      if (exchanges instanceof Error) throw exchanges;
      return exchanges.map((exchange, i) => ({ exchange, priority: 10 * (i + 1) }));
    }),
  };
}

describe('mxPointsAt', () => {
  it('matches the mail host case-insensitively, with or without the trailing dot', async () => {
    await expect(mxPointsAt(resolverWithMx(['backup.example.test', 'MAIL.Platform.Example.test.']), 'shop.example.test', MAIL_HOST))
      .resolves.toBe(true);
  });

  it('is false when no MX names the mail host', async () => {
    await expect(mxPointsAt(resolverWithMx(['mx.elsewhere.example.test']), 'shop.example.test', MAIL_HOST)).resolves.toBe(false);
  });

  it('is false, not an error, when the lookup fails', async () => {
    await expect(mxPointsAt(resolverWithMx(new Error('ENOTFOUND')), 'shop.example.test', MAIL_HOST)).resolves.toBe(false);
  });

  it('is false when the resolver cannot look up MX at all', async () => {
    const noMx: DnsLike = { resolve4: vi.fn(), resolve6: vi.fn(), resolveNs: vi.fn(), resolveCname: vi.fn() };
    await expect(mxPointsAt(noMx, 'shop.example.test', MAIL_HOST)).resolves.toBe(false);
  });

  it('is false when no mail host is configured', async () => {
    await expect(mxPointsAt(resolverWithMx(['']), 'shop.example.test', '')).resolves.toBe(false);
  });
});

describe('assertDnsControlForMail', () => {
  it('accepts a domain that has passed verification, without a lookup', async () => {
    const resolver = resolverWithMx([]);
    await expect(assertDnsControlForMail(db, { domainName: 'shop.example.test', verifiedAt: new Date() }, { resolver, mailHost: MAIL_HOST }))
      .resolves.toBeUndefined();
    expect(resolver.resolveMx).not.toHaveBeenCalled();
  });

  it('accepts an unverified domain whose MX already points here (a mail-only domain)', async () => {
    await expect(assertDnsControlForMail(db, { domainName: 'shop.example.test', verifiedAt: null }, { resolver: resolverWithMx([MAIL_HOST]), mailHost: MAIL_HOST }))
      .resolves.toBeUndefined();
  });

  it('refuses an unverified domain whose MX points elsewhere, naming the MX to publish', async () => {
    const err = await assertDnsControlForMail(
      db,
      { domainName: 'Shop.Example.test', verifiedAt: null },
      { resolver: resolverWithMx(['mx.elsewhere.example.test']), mailHost: MAIL_HOST },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('DOMAIN_DNS_CONTROL_UNPROVEN');
    expect(apiErr.status).toBe(409);
    expect(apiErr.message).toContain("'shop.example.test'");
    expect(apiErr.message).toContain(MAIL_HOST);
  });
});
