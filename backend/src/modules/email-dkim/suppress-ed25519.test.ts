/**
 * Unit tests for the pure Ed25519-selection logic. The JMAP round-trip
 * (get → destroy) is exercised by the live E2E
 * (enable domain → assert RSA-only signatures).
 */
import { describe, it, expect } from 'vitest';
import { selectEd25519SignatureIds, selectAllSignatureIds, ED25519_SIGNATURE_TYPE } from './suppress-ed25519.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

const rows: readonly StalwartDkimSignatureRow[] = [
  { id: 'a1', '@type': 'Dkim1RsaSha256', domainId: 'd1', selector: 'v1-rsa-20260607' },
  { id: 'a2', '@type': ED25519_SIGNATURE_TYPE, domainId: 'd1', selector: 'v1-ed25519-20260607' },
  { id: 'b1', '@type': 'Dkim1RsaSha256', domainId: 'd2', selector: 'v1-rsa-20260601' },
  { id: 'b2', '@type': ED25519_SIGNATURE_TYPE, domainId: 'd2', selector: 'v1-ed25519-20260601' },
  { id: 'b3', '@type': ED25519_SIGNATURE_TYPE, domainId: 'd2', selector: 'default' },
];

describe('email-dkim/suppress-ed25519: selectEd25519SignatureIds', () => {
  it('selects only Ed25519 rows for the given domain', () => {
    expect(selectEd25519SignatureIds(rows, 'd1')).toEqual(['a2']);
  });

  it('selects multiple Ed25519 rows (incl. bootstrap "default" selectors)', () => {
    expect(selectEd25519SignatureIds(rows, 'd2')).toEqual(['b2', 'b3']);
  });

  it('never selects RSA rows', () => {
    for (const d of ['d1', 'd2']) {
      const ids = selectEd25519SignatureIds(rows, d);
      expect(ids).not.toContain('a1');
      expect(ids).not.toContain('b1');
    }
  });

  it('returns empty for unknown domains and empty input', () => {
    expect(selectEd25519SignatureIds(rows, 'd9')).toEqual([]);
    expect(selectEd25519SignatureIds([], 'd1')).toEqual([]);
  });
});

describe('email-dkim/suppress-ed25519: selectAllSignatureIds', () => {
  it('selects every signature for the domain regardless of algorithm', () => {
    expect(selectAllSignatureIds(rows, 'd2')).toEqual(['b1', 'b2', 'b3']);
  });

  it('returns empty for unknown domains', () => {
    expect(selectAllSignatureIds(rows, 'nope')).toEqual([]);
  });
});
