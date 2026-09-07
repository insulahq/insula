import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationChecksTable } from '@/components/VerificationChecksTable';

describe('VerificationChecksTable', () => {
  it('shows EXPECTED and ACTUAL side by side', () => {
    render(<VerificationChecksTable checks={[{
      type: 'ns_delegation',
      status: 'fail',
      detail: 'x',
      expected: ['ns1.platform.test', 'ns2.platform.test'],
      actual: ['ns1.someone-else.net'],
    }]} />);
    expect(screen.getByTestId('verify-expected-ns_delegation')).toHaveTextContent('ns1.platform.test, ns2.platform.test');
    expect(screen.getByTestId('verify-actual-ns_delegation')).toHaveTextContent('ns1.someone-else.net');
  });

  it('marks an EMPTY expectation as "not configured" rather than rendering a blank cell', () => {
    // The whole point of the table. An unconfigured platform previously showed
    // a green "DNS verification passed" and nothing else; a blank cell here
    // would reproduce that ambiguity in a new place.
    render(<VerificationChecksTable checks={[{
      type: 'ns_delegation', status: 'fail', detail: 'x', expected: [], actual: ['ns1.someone-else.net'],
    }]} />);
    expect(screen.getByTestId('verify-expected-ns_delegation')).toHaveTextContent('not configured');
  });

  it('renders PASSED checks too, so a pass is auditable', () => {
    render(<VerificationChecksTable checks={[{
      type: 'ns_delegation', status: 'pass', detail: 'ok',
      expected: ['ns1.platform.test'], actual: ['ns1.platform.test'],
    }]} />);
    expect(screen.getByTestId('verify-check-ns_delegation')).toBeInTheDocument();
  });

  it('renders nothing when no check carries a comparison (old cached results)', () => {
    const { container } = render(<VerificationChecksTable checks={[{ type: 'ns_delegation', status: 'pass', detail: 'ok' }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
