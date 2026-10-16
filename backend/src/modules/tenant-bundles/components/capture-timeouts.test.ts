import { describe, it, expect } from 'vitest';
import {
  BUNDLE_MAX_RUNNING_MS,
  FILES_CAPTURE_TIMEOUT_MS,
  MAILBOXES_CAPTURE_TIMEOUT_MS,
} from './capture-timeouts.js';

describe('capture timeouts', () => {
  it('give each capture Job 2 hours', () => {
    expect(FILES_CAPTURE_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
    expect(MAILBOXES_CAPTURE_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('let a bundle outlive its slowest capture before the sweeper calls it stuck', () => {
    // The sweeper reaps on started_at; the database pre-dumps run before the
    // files capture, so the margin must cover them as well as finalisation.
    const slowest = Math.max(FILES_CAPTURE_TIMEOUT_MS, MAILBOXES_CAPTURE_TIMEOUT_MS);
    expect(BUNDLE_MAX_RUNNING_MS - slowest).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
