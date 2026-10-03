/**
 * "Re-pinned to sv1 — restarted 0 deployment(s)" read as success for a stopped
 * tenant whose data never moved, and the operator pressed Move back again and
 * again. The note must say where the data is going, or why it is not.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import MigrateResultNote from '@/components/tenants/MigrateResultNote';

const result = (over: Partial<MigrateToWorkerResult> = {}): MigrateToWorkerResult => ({
  tenantId: 't1', previousWorker: 'node-b', currentWorker: 'node-a', deploymentsRestarted: 0,
  dataRelocation: { started: [], skipped: [], error: null }, ...over,
});

describe('MigrateResultNote', () => {
  it('a stopped tenant: says its data is being moved, not "restarted 0"', () => {
    render(<MigrateResultNote result={result({ dataRelocation: { started: ['pvc-1'], skipped: [], error: null } })} />);
    const note = screen.getByTestId('migrate-result');
    expect(note).toHaveTextContent('Pinned to node-a. Moving the data there now (1 volume)');
    expect(note).not.toHaveTextContent('restarted 0');
  });

  it('a running tenant: the restarted workloads carry the data', () => {
    render(<MigrateResultNote result={result({ deploymentsRestarted: 2, dataRelocation: { started: [], skipped: [{ volumeName: 'pvc-1', reason: 'in-use' }], error: null } })} />);
    expect(screen.getByTestId('migrate-result')).toHaveTextContent('Pinned to node-a — restarted 2 deployment(s). The restarted workloads take the data with them');
  });

  it('says plainly when the data could not be moved', () => {
    render(<MigrateResultNote result={result({ dataRelocation: { started: [], skipped: [], error: 'forbidden' } })} />);
    expect(screen.getByTestId('migrate-relocation-error')).toHaveTextContent('The data could not be moved: forbidden.');
  });
});
