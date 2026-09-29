/// <reference types="@testing-library/jest-dom" />
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

/**
 * jsdom implements no ResizeObserver, and any component that measures its own
 * box needs one — the traffic chart sizes its viewBox from the container, and
 * NodeTerminalModal refits xterm the same way. A no-op observer is enough:
 * these tests assert on what was rendered, not on how it reflows.
 */
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void { /* no layout in jsdom to report */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
