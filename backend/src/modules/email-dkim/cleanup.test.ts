/**
 * Unit tests for the pure disable-flow selection logic. The JMAP
 * round-trip (get → destroy) is exercised by the live E2E
 * (disable domain → assert no orphaned signatures).
 */
import { describe, it, expect } from 'vitest';
import { selectAllSignatureIds } from './cleanup.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

const rows: readonly StalwartDkimSignatureRow[] = [
  { id: 'a1', '@type': 'Dkim1RsaSha256', domainId: 'd1', selector: 'dkim-1' },
  { id: 'a2', '@type': 'Dkim1Ed25519Sha256', domainId: 'd1', selector: 'v1-ed25519-20260607' },
  { id: 'b1', '@type': 'Dkim1RsaSha256', domainId: 'd2', selector: 'dkim-1' },
  { id: 'b2', '@type': 'Dkim1RsaSha256', domainId: 'd2', selector: 'dkim-2' },
  { id: 'b3', '@type': 'Dkim1Ed25519Sha256', domainId: 'd2', selector: 'default' },
];

describe('email-dkim/cleanup: selectAllSignatureIds', () => {
  it('selects every signature for the domain regardless of algorithm or selector', () => {
    expect(selectAllSignatureIds(rows, 'd2')).toEqual(['b1', 'b2', 'b3']);
  });

  it('does not leak rows from other domains', () => {
    expect(selectAllSignatureIds(rows, 'd1')).toEqual(['a1', 'a2']);
  });

  it('returns empty for unknown domains and empty input', () => {
    expect(selectAllSignatureIds(rows, 'nope')).toEqual([]);
    expect(selectAllSignatureIds([], 'd1')).toEqual([]);
  });
});
