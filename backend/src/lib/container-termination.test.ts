import { describe, it, expect } from 'vitest';
import {
  OOM_EXIT_CODE,
  isOomTermination,
  describeTermination,
  messageIndicatesOom,
} from './container-termination.js';

describe('container-termination', () => {
  describe('isOomTermination', () => {
    // The case that motivated this module. Copied from the real
    // lastState.terminated of the production vmsingle pod on 2026-08-30,
    // whose kill the kernel logged as "Memory cgroup out of memory".
    // The old `reason === 'OOMKilled'` test returned false for this.
    it('recognises the kubelet reporting a cgroup OOM as reason="Error"', () => {
      const productionVmsingle = { exitCode: 137, reason: 'Error' };
      expect(isOomTermination(productionVmsingle)).toBe(true);
    });

    it('still recognises the explicit reason', () => {
      expect(isOomTermination({ reason: 'OOMKilled', exitCode: 137 })).toBe(true);
      // Reason alone, no exit code — some paths only carry the reason.
      expect(isOomTermination({ reason: 'OOMKilled' })).toBe(true);
    });

    it('recognises a bare SIGKILL exit with no reason at all', () => {
      expect(isOomTermination({ exitCode: OOM_EXIT_CODE })).toBe(true);
    });

    it('does not fire on ordinary failures', () => {
      expect(isOomTermination({ exitCode: 1, reason: 'Error' })).toBe(false);
      expect(isOomTermination({ exitCode: 0, reason: 'Completed' })).toBe(false);
      // 143 is SIGTERM — a graceful stop, not an OOM.
      expect(isOomTermination({ exitCode: 143, reason: 'Error' })).toBe(false);
    });

    it('does not fire on absent state', () => {
      expect(isOomTermination(undefined)).toBe(false);
      expect(isOomTermination(null)).toBe(false);
      expect(isOomTermination({})).toBe(false);
    });
  });

  describe('describeTermination', () => {
    it('upgrades an unexplained SIGKILL to the actionable diagnosis', () => {
      expect(describeTermination({ exitCode: 137, reason: 'Error' })).toBe('OOMKilled');
    });

    it('passes other reasons through unchanged', () => {
      expect(describeTermination({ exitCode: 1, reason: 'Error' })).toBe('Error');
      expect(describeTermination({ exitCode: 0, reason: 'Completed' })).toBe('Completed');
    });

    it('distinguishes "not terminated" from "terminated, reason unknown"', () => {
      // null means there was no termination to describe...
      expect(describeTermination(undefined)).toBeNull();
      // ...and so does a termination carrying neither field, which is
      // correct: there is nothing to report, and callers branch on null.
      expect(describeTermination({})).toBeNull();
      // But an exit code alone IS reportable.
      expect(describeTermination({ exitCode: 137 })).toBe('OOMKilled');
    });
  });

  describe('messageIndicatesOom', () => {
    it('matches both renderings used by the text-only paths', () => {
      expect(messageIndicatesOom('command failed with exit code 137')).toBe(true);
      expect(messageIndicatesOom('container was OOMKilled')).toBe(true);
    });

    it('does not match a different exit code', () => {
      expect(messageIndicatesOom('command failed with exit code 1')).toBe(false);
      expect(messageIndicatesOom('exit code 13')).toBe(false);
    });
  });
});
