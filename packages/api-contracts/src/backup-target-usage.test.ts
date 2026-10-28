import { describe, it, expect } from 'vitest';
import { classStoredTotal, type TargetUsageRow, type BackupUsageClass } from './backup-target-usage.js';

type Folders = Partial<Record<BackupUsageClass, number | null>>;

function row(id: string, bound: BackupUsageClass[], folders: Folders | null, measuredAt = '2026-10-28T08:22:05.315Z'): TargetUsageRow {
  const classes = { system: null, tenant: null, mail: null } as Record<BackupUsageClass, { bytes: number; objects: number } | null>;
  const errors: Record<string, string> = {};
  for (const [cls, bytes] of Object.entries(folders ?? {}) as Array<[BackupUsageClass, number | null]>) {
    if (bytes === null) errors[cls] = 'directory not found';
    else classes[cls] = { bytes, objects: 1 };
  }
  return {
    targetId: id,
    name: id,
    storageType: 'cifs',
    enabled: true,
    readOnly: false,
    boundClasses: bound,
    usage: folders === null ? null : {
      measuredAt,
      durationMs: 1,
      classes,
      usedByBackupsBytes: 0,
      capacity: null,
      capacityNote: null,
      errors,
    },
    measuringSince: null,
  };
}

describe('classStoredTotal', () => {
  it('is the class folder on the target, not a backup tool’s own count', () => {
    // Production: one target holds all three classes.
    const box = row('box', ['system', 'tenant', 'mail'], { system: 5_987_344_884, tenant: 204_376_364_099, mail: 63_739_157_939 });
    expect(classStoredTotal([box], 'mail').bytes).toBe(63_739_157_939);
    expect(classStoredTotal([box], 'tenant').holders).toEqual([{ targetId: 'box', name: 'box', bytes: 204_376_364_099 }]);
  });

  it('adds what a class switch left on the previous target', () => {
    const old = row('old', [], { tenant: 40 }, '2026-10-27T00:00:00.000Z');
    const now = row('now', ['tenant'], { tenant: 2 });
    const total = classStoredTotal([now, old], 'tenant');
    expect(total.bytes).toBe(42);
    expect(total.measuredAt).toBe('2026-10-27T00:00:00.000Z');
  });

  it('counts an empty folder on the bound target as a real zero, and ignores one elsewhere', () => {
    const total = classStoredTotal([row('now', ['mail'], { mail: 0 }), row('other', ['tenant'], { mail: 0 })], 'mail');
    expect(total.holders.map((h) => h.targetId)).toEqual(['now']);
    expect(total.bytes).toBe(0);
  });

  it('names a bound target whose folder could not be listed, and has no figure from it', () => {
    const total = classStoredTotal([row('now', ['tenant'], { tenant: null })], 'tenant');
    expect(total.holders).toEqual([]);
    expect(total.unlisted).toEqual([{ targetId: 'now', name: 'now', error: 'directory not found' }]);
    expect(total.measuredAt).toBeNull();
  });

  it('names a bound target that was never measured, so a sum without it is not taken as complete', () => {
    const total = classStoredTotal([row('new', ['tenant'], null), row('old', [], { tenant: 40 }), row('spare', [], null)], 'tenant');
    expect(total.bytes).toBe(40);
    expect(total.unmeasured).toEqual([{ targetId: 'new', name: 'new' }]);
    expect(total.unlisted).toEqual([]);
  });

  it('has nothing for a target that was never measured', () => {
    const total = classStoredTotal([row('now', ['tenant'], null)], 'tenant');
    expect(total).toEqual({ bytes: 0, holders: [], unlisted: [], unmeasured: [{ targetId: 'now', name: 'now' }], measuredAt: null });
  });
});
