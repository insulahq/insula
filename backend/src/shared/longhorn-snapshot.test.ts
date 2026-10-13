import { describe, expect, it } from 'vitest';
import { isSnapshotSomebodyTook } from './longhorn-snapshot.js';

/** The three kinds a cluster running Longhorn v1.12 holds, with the fields it returns for each. */
const taken = { spec: { labels: { type: 'snap' } }, status: { userCreated: true, labels: { type: 'snap' } } };
const marker = { spec: { labels: null }, status: { userCreated: false, labels: { 'replica-expansion': '3221225472' } } };
const scheduled = { spec: { labels: { RecurringJob: 'hourly-snap' } }, status: { userCreated: true, labels: { RecurringJob: 'hourly-snap' } } };

describe('a snapshot somebody took', () => {
  it('one taken through the platform is', () => {
    expect(isSnapshotSomebodyTook(taken)).toBe(true);
  });

  it('Longhorn\'s marker on an expansion is not', () => {
    expect(isSnapshotSomebodyTook(marker)).toBe(false);
  });

  it('a recurring job\'s is not, although Longhorn flags it user-created', () => {
    expect(isSnapshotSomebodyTook(scheduled)).toBe(false);
  });

  it('the job\'s label counts in the spec or in the status alone', () => {
    expect(isSnapshotSomebodyTook({ ...scheduled, spec: { labels: null } })).toBe(false);
    expect(isSnapshotSomebodyTook({ ...scheduled, status: { userCreated: true, labels: null } })).toBe(false);
  });

  it('the flag is read from the status: one in the spec, where no snapshot has it, counts for nothing', () => {
    expect(isSnapshotSomebodyTook({ spec: { labels: null, userCreated: true } as never, status: {} })).toBe(false);
    expect(isSnapshotSomebodyTook({})).toBe(false);
  });
});
