/// <reference types="@testing-library/jest-dom" />
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

/**
 * The matchers' TYPES for vitest 5. jest-dom 7.0.1 types them on vitest's
 * one-parameter `Assertion<T>` and on the global `jest.Matchers`, which vitest
 * 4's assertions extended; vitest 5's `Assertion<R, T>` extends neither, so
 * `expect(el).toBeInTheDocument()` ran but no longer typechecked. vitest 5's
 * extension point is `Matchers<R, T>`. Drop this once jest-dom ships it.
 */
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- an augmentation adds members by extending; it must repeat vitest's own parameters to merge
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {}
}

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
