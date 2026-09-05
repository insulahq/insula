import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

/**
 * CAA wire format: `<flags> <tag> "<value>"` — e.g. `0 issue "letsencrypt.org"`.
 * The quotes around the value are optional here; the provider adds them.
 */
export const CAA_CONTENT_PATTERN = /^\d+\s+[a-zA-Z0-9]+\s+\S.*$/;

/**
 * Types whose wire content embeds numeric fields the caller must supply
 * separately. A bare hostname is NOT a valid MX or SRV record: PowerDNS
 * (and every other authoritative server) parses MX content as
 * `<priority> <hostname>` and rejects anything else with a 422.
 *
 * Enforced here rather than only at the provider so the panel gets a 400
 * with a field-level message *before* anything is written to the local DB.
 */
function requireCompositeFields(
  value: { record_type: string; record_value: string; priority?: number; weight?: number; port?: number },
  ctx: z.RefinementCtx,
): void {
  if (value.record_type === 'MX' && value.priority == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['priority'],
      message: 'MX records require a priority (preference), e.g. 10.',
    });
  }
  if (value.record_type === 'SRV') {
    for (const field of ['priority', 'weight', 'port'] as const) {
      if (value[field] == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `SRV records require ${field}.`,
        });
      }
    }
  }
  if (value.record_type === 'CAA' && !CAA_CONTENT_PATTERN.test(value.record_value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['record_value'],
      message: 'CAA records must be written as \'<flags> <tag> "<value>"\', e.g. 0 issue "letsencrypt.org".',
    });
  }
  // A zone has exactly one SOA and the authoritative server owns it: it is
  // created with the zone and its serial is rewritten on every change.
  // Adding one always failed at the provider ("RRset … IN SOA has more than
  // one record") — verified against PowerDNS 4.9. The type stays in the DB
  // enum because a zone PULLED from a provider carries its SOA.
  if (value.record_type === 'SOA') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['record_type'],
      message: 'SOA records are managed by the DNS server and cannot be created or edited here.',
    });
  }
}

export const createDnsRecordSchema = z.object({
  record_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'SOA', 'ALIAS', 'DNAME']),
  record_name: z.string().max(253).optional(),
  record_value: z.string().max(1000),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).optional(),
  weight: z.number().int().min(0).max(65535).optional(),
  port: z.number().int().min(0).max(65535).optional(),
}).superRefine(requireCompositeFields);

export const updateDnsRecordSchema = z.object({
  record_value: z.string().max(1000).optional(),
  ttl: z.number().int().min(60).max(86400).optional(),
  priority: z.number().int().min(0).max(65535).optional(),
  weight: z.number().int().min(0).max(65535).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

// ─── Per-type field requirements (shared by both panels) ─────────────────────

export interface DnsRecordFieldRequirements {
  /** Render a priority input, and require it. */
  readonly priority: boolean;
  /** Render weight + port inputs, and require them. */
  readonly srvFields: boolean;
  /** Placeholder for the value input. */
  readonly valuePlaceholder: string;
  /** Short hint rendered under the value input, or null. */
  readonly valueHint: string | null;
}

/**
 * What a given record type needs beyond name/value/ttl.
 *
 * Lives in the contract so the panels and `createDnsRecordSchema` cannot
 * drift: the forms used to collect only type/name/value/ttl for all twelve
 * types in the dropdown, which made MX, SRV and CAA impossible to create
 * correctly — the API accepted them and the DNS server then rejected them.
 */
export function dnsRecordFieldsFor(type: string): DnsRecordFieldRequirements {
  switch (type.toUpperCase()) {
    case 'MX':
      return { priority: true, srvFields: false, valuePlaceholder: 'mail.example.test', valueHint: 'Mail server hostname. Priority is required — lower wins.' };
    case 'SRV':
      return { priority: true, srvFields: true, valuePlaceholder: 'sip.example.test', valueHint: 'Target hostname. Priority, weight and port are all required.' };
    case 'CAA':
      return { priority: false, srvFields: false, valuePlaceholder: '0 issue "letsencrypt.org"', valueHint: 'Format: <flags> <tag> "<value>" — e.g. 0 issue "letsencrypt.org".' };
    case 'TXT':
      return { priority: false, srvFields: false, valuePlaceholder: 'v=spf1 mx ~all', valueHint: null };
    case 'AAAA':
      return { priority: false, srvFields: false, valuePlaceholder: '2001:db8::1', valueHint: null };
    case 'CNAME':
    case 'NS':
    case 'PTR':
    case 'DNAME':
    case 'ALIAS':
      return { priority: false, srvFields: false, valuePlaceholder: 'target.example.test', valueHint: null };
    default:
      return { priority: false, srvFields: false, valuePlaceholder: '203.0.113.10', valueHint: null };
  }
}

// ─── Response Schemas ────────────────────────────────────────────────────────

export const dnsRecordResponseSchema = z.object({
  id: uuidField,
  domainId: uuidField,
  recordType: z.string(),
  recordName: z.string().nullable(),
  recordValue: z.string().nullable(),
  ttl: z.number(),
  priority: z.number().nullable(),
  weight: z.number().nullable(),
  port: z.number().nullable(),
  updatedAt: z.string(),
});

export const dnsRecordListResponseSchema = paginatedResponseSchema(dnsRecordResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDnsRecordInput = z.infer<typeof createDnsRecordSchema>;

/** Wire shape (z.input): `.default(x)` fields are optional when sending. */
export type CreateDnsRecordRequest = z.input<typeof createDnsRecordSchema>;

export type UpdateDnsRecordInput = z.infer<typeof updateDnsRecordSchema>;
export type DnsRecordResponse = z.infer<typeof dnsRecordResponseSchema>;
export type DnsRecordListResponse = z.infer<typeof dnsRecordListResponseSchema>;
