import { describe, it, expect } from 'vitest';
import { isUsableCopy } from './replica-copy.js';

describe('isUsableCopy', () => {
  it('a running replica is a copy, attached or not', () => {
    expect(isUsableCopy({ status: { currentState: 'running' } }, 'attached')).toBe(true);
    expect(isUsableCopy({ status: { currentState: 'running' } }, undefined)).toBe(true);
  });

  it('a detached volume\'s stopped replicas are its copies — unless they failed', () => {
    expect(isUsableCopy({ spec: { failedAt: '' }, status: { currentState: 'stopped' } }, 'detached')).toBe(true);
    expect(isUsableCopy({ status: { currentState: 'stopped' } }, 'detached')).toBe(true);
    expect(isUsableCopy({ spec: { failedAt: '2026-10-17T10:00:00Z' }, status: { currentState: 'stopped' } }, 'detached')).toBe(false);
  });

  it('while attached, a stopped or errored replica is out of the engine — not a copy', () => {
    expect(isUsableCopy({ spec: { failedAt: '' }, status: { currentState: 'stopped' } }, 'attached')).toBe(false);
    expect(isUsableCopy({ status: { currentState: 'error' } }, 'attached')).toBe(false);
    expect(isUsableCopy({ status: { currentState: 'stopped' } }, undefined)).toBe(false);
  });
});
