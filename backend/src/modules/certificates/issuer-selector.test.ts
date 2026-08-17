import { describe, it, expect } from 'vitest';
import { selectIssuerForDomain, type IssuerSelectorInput } from './issuer-selector.js';

describe('selectIssuerForDomain', () => {
  const defaults = {
    letsencryptProdHttp01: 'letsencrypt-prod-http01',
    letsencryptStagingHttp01: 'letsencrypt-staging-http01',
    platformDns01Prod: 'letsencrypt-prod-dns01-insula',
    platformDns01Staging: 'letsencrypt-staging-dns01-insula',
    // Empty by default: per-provider issuers are legacy overrides now,
    // only present when an operator set CERT_ISSUER_DNS01_* explicitly.
    dns01Issuers: {},
    localCaIssuer: 'local-ca-issuer',
    fallbackIssuer: 'letsencrypt-prod-http01',
  };

  it('chooses DNS-01 wildcard issuer when primary PowerDNS + wildcard requested in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input)).toEqual({
      issuerName: 'letsencrypt-prod-dns01-insula',
      challengeType: 'dns01',
      wildcardCapable: true,
    });
  });

  it('chooses HTTP-01 prod issuer when dnsMode=cname in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'cname',
      activeServers: [],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input)).toEqual({
      issuerName: 'letsencrypt-prod-http01',
      challengeType: 'http01',
      wildcardCapable: false,
    });
  });

  it('chooses HTTP-01 prod issuer when dnsMode=secondary in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'secondary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });

  it('chooses staging HTTP-01 in staging environment', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'cname',
      activeServers: [],
      wildcardRequested: false,
      environment: 'staging',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input).issuerName).toBe('letsencrypt-staging-http01');
  });

  it('chooses local CA issuer in dev environment regardless of dnsMode', () => {
    const cases: Array<'primary' | 'cname' | 'secondary'> = ['primary', 'cname', 'secondary'];
    for (const mode of cases) {
      const result = selectIssuerForDomain({
        dnsMode: mode,
        activeServers: [],
        wildcardRequested: false,
        environment: 'development',
        issuers: defaults,
      });
      expect(result.issuerName).toBe('local-ca-issuer');
      expect(result.challengeType).toBe('ca');
    }
  });

  it('chooses DNS-01 wildcard issuer for Cloudflare primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-insula');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for Route53 primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'route53', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-insula');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for Hetzner primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'hetzner', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-insula');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for ClouDNS primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'cloudns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-insula');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('falls back to HTTP-01 when wildcard requested but no writable provider present', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        // `mock` writes nowhere a resolver can see it.
        { id: 's1', providerType: 'mock', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });

  it('uses the platform solver issuer for every provider type', () => {
    // Previously this fell back to the HTTP-01 issuer while still
    // reporting challengeType 'dns01' — i.e. it produced a wildcard
    // order on an issuer that can never validate one, and the order sat
    // Pending forever with nobody told.
    for (const providerType of ['powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'cloudns']) {
      const result = selectIssuerForDomain({
        dnsMode: 'primary',
        activeServers: [{ id: 's1', providerType, enabled: 1, role: 'primary' }],
        wildcardRequested: true,
        environment: 'production',
        issuers: defaults,
      });
      expect(result, providerType).toEqual({
        issuerName: 'letsencrypt-prod-dns01-insula',
        challengeType: 'dns01',
        wildcardCapable: true,
      });
    }
  });

  it('honours an explicitly configured per-provider issuer', () => {
    // An operator who already hand-wired a working solver keeps it.
    const result = selectIssuerForDomain({
      dnsMode: 'primary',
      activeServers: [{ id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' }],
      wildcardRequested: true,
      environment: 'production',
      issuers: { ...defaults, dns01Issuers: { cloudflare: 'my-cloudflare-issuer' } },
    });
    expect(result.issuerName).toBe('my-cloudflare-issuer');
  });

  it('issues wildcards on staging too, via the staging solver issuer', () => {
    // Staging used to be HTTP-01 only, so the wildcard path could not be
    // exercised anywhere before production.
    const result = selectIssuerForDomain({
      dnsMode: 'primary',
      activeServers: [{ id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' }],
      wildcardRequested: true,
      environment: 'staging',
      issuers: defaults,
    });
    expect(result).toEqual({
      issuerName: 'letsencrypt-staging-dns01-insula',
      challengeType: 'dns01',
      wildcardCapable: true,
    });
  });

  it('returns wildcard=false when wildcardRequested=false even with PowerDNS primary', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    // Can use HTTP-01 for a single hostname — simpler than DNS-01 when no
    // wildcard is needed, and avoids nameserver round trips.
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });
});
