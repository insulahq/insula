// ─── DNS Provider Adapter Interface ───────────────────────────────────────────

export interface DnsZone {
  readonly name: string;
  readonly kind: string; // Native, Master, Slave
  readonly serial: number;
  readonly records_count?: number;
}

export interface DnsRecord {
  readonly id: string;
  readonly type: string; // A, AAAA, CNAME, MX, TXT, SRV, NS
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly priority?: number | null;
}

export interface DnsRecordInput {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl?: number;
  /** MX preference / SRV priority. REQUIRED for MX and SRV — the wire
   *  format embeds it in the record content, and providers reject content
   *  that is missing it. */
  readonly priority?: number;
  /** SRV weight. REQUIRED for SRV. */
  readonly weight?: number;
  /** SRV port. REQUIRED for SRV. */
  readonly port?: number;
}

export interface DnsProviderAdapter {
  readonly providerType: string;

  testConnection(): Promise<{ status: 'ok' | 'error'; message?: string; version?: string }>;

  listZones(): Promise<DnsZone[]>;
  getZone(name: string): Promise<DnsZone | null>;
  /**
   * Create a zone.
   *
   * `nameservers` is the apex NS set, supplied by the domain's DNS provider
   * group (`dns_provider_groups.ns_hostnames`). Self-hosted providers that
   * require an explicit NS RRset (PowerDNS, BIND) MUST use it verbatim.
   * Cloud providers that assign their own nameservers ignore it.
   *
   * Callers must pass a non-empty list for self-hosted providers — a zone
   * whose NS records point at names that don't exist is a lame delegation
   * that resolves for nobody, which is exactly what a hardcoded
   * `ns1.<zone>` placeholder used to produce.
   */
  createZone(name: string, kind: 'Native' | 'Master', nameservers?: string[]): Promise<DnsZone>;
  deleteZone(name: string): Promise<void>;

  listRecords(zone: string): Promise<DnsRecord[]>;
  createRecord(zone: string, record: DnsRecordInput): Promise<DnsRecord>;
  updateRecord(zone: string, recordId: string, record: Partial<DnsRecordInput>): Promise<DnsRecord>;
  deleteRecord(zone: string, recordId: string): Promise<void>;

  // Optional — secondary/slave DNS support
  createSlaveZone?(name: string, masterIp: string): Promise<DnsZone>;
  getZoneAxfrStatus?(name: string): Promise<{ synced: boolean; lastSoaSerial?: number }>;

  // Optional — replace all NS records at zone root with specific nameservers
  replaceNsRecords?(zone: string, nameservers: string[]): Promise<void>;

  /**
   * Optional — delete ONE value from a record set, leaving any other
   * values at the same (name, type) in place.
   *
   * Required for correct ACME DNS-01 cleanup on RRset-oriented providers.
   * PowerDNS keys records by (name, type) and its `deleteRecord` removes
   * the whole RRset; a single ACME order for `example.test` +
   * `*.example.test` produces TWO TXT values at
   * `_acme-challenge.example.test`, so cleaning up the first challenge
   * would delete the second one's proof mid-validation.
   *
   * Providers that address records individually (Cloudflare, Route53)
   * don't need this — the solver falls back to looking the record id up
   * and calling `deleteRecord`.
   */
  deleteRecordValue?(zone: string, record: DnsRecordInput): Promise<void>;
}

// ─── Provider Config Types ───────────────────────────────────────────────────

export interface PowerDnsConfig {
  readonly api_url: string;
  readonly api_key: string;
  readonly server_id: string;
  readonly api_version: 'v4' | 'v5';
}

export interface RndcConfig {
  readonly server_host: string;
  readonly rndc_port: number;
  readonly rndc_key_name: string;
  readonly rndc_key_algorithm: string;
  readonly rndc_key_secret: string;
}

export interface CloudflareConfig {
  readonly api_token: string;
}

export interface Route53Config {
  readonly access_key_id: string;
  readonly secret_access_key: string;
  readonly region: string;
  readonly hosted_zone_id?: string;
}

export interface HetznerDnsConfig {
  readonly api_token: string;
}

export interface ClouDnsConfig {
  readonly auth_id?: string;
  readonly sub_auth_id?: string;
  readonly auth_password: string;
  readonly api_url?: string;
}

export interface MockConfig {
  readonly latency_ms?: number;
}
