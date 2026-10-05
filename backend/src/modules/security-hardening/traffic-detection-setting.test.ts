import { describe, it, expect, vi } from 'vitest';
import {
  TRAFFIC_DETECTION_ENABLED_KEY,
  parseStoredFlag,
  readTrafficDetectionEnabled,
  writeTrafficDetectionEnabled,
} from './traffic-detection-setting.js';

/**
 * The saved on/off choice for Malicious Traffic Detection. It is what the
 * startup reconcile re-applies when the agent's ConfigMap is recreated, so a
 * value it cannot read must come back as "unknown" (null) — never as a
 * guessed state that would arm or disarm bans on its own.
 */
describe('parseStoredFlag', () => {
  it('reads the two values the platform writes', () => {
    expect(parseStoredFlag('true')).toBe(true);
    expect(parseStoredFlag('false')).toBe(false);
  });

  it('treats an absent row as unset, not as "enabled"', () => {
    expect(parseStoredFlag(undefined)).toBeNull();
  });

  it('treats a garbled value as unset rather than guessing', () => {
    expect(parseStoredFlag('')).toBeNull();
    expect(parseStoredFlag('yes')).toBeNull();
    expect(parseStoredFlag(' TRUE ')).toBe(true);
  });
});

describe('platform_settings round-trip', () => {
  function fakeDb(rows: { value: string }[]) {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const where = vi.fn().mockResolvedValue(rows);
    return {
      db: {
        select: () => ({ from: () => ({ where }) }),
        insert: vi.fn(() => ({ values })),
      },
      values,
      onConflictDoUpdate,
    };
  }

  it('reads the stored flag', async () => {
    const { db } = fakeDb([{ value: 'false' }]);
    expect(await readTrafficDetectionEnabled(db as never)).toBe(false);
  });

  it('reads null when the key was never saved', async () => {
    const { db } = fakeDb([]);
    expect(await readTrafficDetectionEnabled(db as never)).toBeNull();
  });

  it('upserts the key with a plain true/false string', async () => {
    const { db, values, onConflictDoUpdate } = fakeDb([]);
    await writeTrafficDetectionEnabled(db as never, false);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      key: TRAFFIC_DETECTION_ENABLED_KEY, value: 'false',
    }));
    // An upsert, not an insert: the second toggle must overwrite the first.
    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ value: 'false' }),
    }));
  });

  it('uses the crowdsec settings namespace', () => {
    expect(TRAFFIC_DETECTION_ENABLED_KEY).toBe('security.crowdsec.traffic_detection_enabled');
  });
});
