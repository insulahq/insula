import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatCpuCompact, formatBytesCompact } from '@/components/ResourceMetricsModal';

const NO_VALUE_DASH = '\u2014';
import ErrorBoundary from '@/components/ErrorBoundary';

/**
 * Reproduces a production crash on the tenant panel:
 *
 *   Cannot read properties of null (reading 'toFixed')
 *
 * The header's resource tiles render fields typed `number` by a HAND-WRITTEN
 * interface (use-resource-metrics.ts). The resource-metrics response is not
 * built from a shared Zod contract, so TypeScript cannot catch the server
 * sending null — and `null.toFixed()` throws during render. The app-level
 * ErrorBoundary then replaced the WHOLE panel, recoverable only by reloading,
 * which is exactly how it was reported ("a hard reload usually fixes it").
 */
describe('resource formatters tolerate a missing number', () => {
  it('does not throw on null — the reported crash', () => {
    expect(() => formatCpuCompact(null as unknown as number)).not.toThrow();
    expect(() => formatBytesCompact(null as unknown as number)).not.toThrow();
  });

  it('renders a dash rather than a bogus number', () => {
    expect(formatCpuCompact(null as unknown as number)).toBe('—');
    expect(formatBytesCompact(undefined as unknown as number)).toBe('—');
    expect(formatCpuCompact(Number.NaN)).toBe('—');
  });

  it('still formats real values unchanged', () => {
    // One decimal, matching the dashboard tile beside it.
    expect(formatCpuCompact(0.02)).toBe('0.0');
    expect(formatCpuCompact(2)).toBe('2.0');
    expect(formatCpuCompact(12)).toBe('12');
    expect(formatBytesCompact(0)).toBe('0Mi');
    expect(formatBytesCompact(0.5)).toBe('512Mi');
    expect(formatBytesCompact(4)).toBe('4.0Gi');
  });

  it('treats 0 as a real value, not a missing one', () => {
    // `!value` would wrongly dash out an idle tenant. The distinction that
    // matters is "0.0" versus the em-dash, not the number of decimals.
    expect(formatCpuCompact(0)).toBe('0.0');
    expect(formatCpuCompact(0)).not.toBe(NO_VALUE_DASH);
  });
});

describe('ErrorBoundary scoped fallback', () => {
  const Boom = () => { throw new Error('boom'); };

  it('replaces only its own subtree when given a fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <span data-testid="sibling">rest of the page</span>
        <ErrorBoundary fallback={null} label="test"><Boom /></ErrorBoundary>
      </div>,
    );
    // The page survives — this is what stops one tile blanking the panel.
    expect(screen.getByTestId('sibling')).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it('still shows the full-screen crash page when no fallback is given', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
  });
});
