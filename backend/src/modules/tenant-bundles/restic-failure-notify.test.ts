import { describe, it, expect } from 'vitest';
import { describeResticFailure } from './restic-failure-notify.js';
import { ResticCommandError } from './restic-driver.js';

const ctx = { operation: 'forget', scope: 'tenant acme / files', dedupeScope: 'acme:files' };

describe('describeResticFailure', () => {
  it('reports a plain failure as a failure', () => {
    const err = new ResticCommandError('restic forget', 1, 'permission denied');
    const out = describeResticFailure(ctx, err);
    expect(out.backupName).toBe('tenant acme / files');
    expect(out.errorMessage).toContain('exited 1');
    expect(out.errorMessage).toContain('permission denied');
    expect(out.errorMessage).not.toMatch(/no longer wedged/);
  });

  it('leads with the recovery when a stale lock was cleared', () => {
    // "The operation failed" and "the repo is wedged" are different facts. The
    // driver self-heals, so sending an operator to unwedge a repo that has
    // already unwedged itself is a false call to action.
    const err = new ResticCommandError('restic forget', 1, 'unable to create lock', true);
    const out = describeResticFailure(ctx, err);
    expect(out.errorMessage).toMatch(/^A stale lock was found and cleared/);
    expect(out.errorMessage).toContain('next scheduled run should succeed');
    // It still says the run failed — this is different wording, not silence.
    expect(out.errorMessage).toContain('exited 1');
  });

  it('truncates stderr so one failure cannot fill an inbox', () => {
    const err = new ResticCommandError('restic prune', 2, 'x'.repeat(5000));
    expect(describeResticFailure(ctx, err).errorMessage.length).toBeLessThan(700);
  });
});
