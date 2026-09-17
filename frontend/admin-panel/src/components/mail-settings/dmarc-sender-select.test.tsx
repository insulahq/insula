/**
 * The DMARC report-sender dropdown.
 *
 * What is worth pinning here is not the rendering — it is the three states that
 * quietly produce the original bug if they collapse into each other:
 *
 *   - "disable" must be a REACHABLE choice. This control exists because
 *     reporting was effectively always on (Stalwart derives a sender from the
 *     server hostname when none is set), so a picker you cannot turn off would
 *     have shipped the same defect behind a nicer widget.
 *   - the search must match tenant and domain. Every option's local part is
 *     the literal word "postmaster", so an address-only search matches
 *     everything and filters nothing.
 *   - a selected address that is no longer eligible must SAY so, not render
 *     blank — blank is indistinguishable from "off".
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import DmarcReportSenderSelect from './DmarcReportSenderSelect';

const OPTIONS = [
  { address: 'postmaster@alpha.test', domainName: 'alpha.test', tenantName: 'Alpha Retail', isSystemTenant: false },
  { address: 'postmaster@beta.test', domainName: 'beta.test', tenantName: 'Beta Clinic', isSystemTenant: false },
  { address: 'postmaster@platform.test', domainName: 'platform.test', tenantName: 'SYSTEM', isSystemTenant: true },
];

function open(props: Partial<React.ComponentProps<typeof DmarcReportSenderSelect>> = {}) {
  const onChange = vi.fn();
  render(
    <DmarcReportSenderSelect options={OPTIONS} value={null} onChange={onChange} {...props} />,
  );
  fireEvent.click(screen.getByTestId('dmarc-sender-trigger'));
  return onChange;
}

describe('DmarcReportSenderSelect', () => {
  it('reports null — not a string — when the operator disables reporting', () => {
    const onChange = open({ value: 'postmaster@alpha.test' });
    fireEvent.click(screen.getByTestId('dmarc-sender-option-disabled'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('keeps the disable option visible while a search is filtering everything out', () => {
    // The safe choice must never be something you have to find.
    open();
    fireEvent.change(screen.getByTestId('dmarc-sender-search'), {
      target: { value: 'nothing-matches-this' },
    });
    expect(screen.getByTestId('dmarc-sender-option-disabled')).toBeTruthy();
    expect(screen.getByTestId('dmarc-sender-no-matches')).toBeTruthy();
  });

  it('searches by tenant name', () => {
    open();
    fireEvent.change(screen.getByTestId('dmarc-sender-search'), { target: { value: 'clinic' } });
    expect(screen.getByTestId('dmarc-sender-option-postmaster@beta.test')).toBeTruthy();
    expect(screen.queryByTestId('dmarc-sender-option-postmaster@alpha.test')).toBeNull();
  });

  it('searches by domain', () => {
    open();
    fireEvent.change(screen.getByTestId('dmarc-sender-search'), { target: { value: 'alpha.' } });
    expect(screen.getByTestId('dmarc-sender-option-postmaster@alpha.test')).toBeTruthy();
    expect(screen.queryByTestId('dmarc-sender-option-postmaster@beta.test')).toBeNull();
  });

  it('a search on the shared local part still narrows nothing — the control', () => {
    // Proves the previous two tests are filtering, not just rendering: the one
    // term every option shares must keep every option.
    open();
    fireEvent.change(screen.getByTestId('dmarc-sender-search'), { target: { value: 'postmaster' } });
    for (const o of OPTIONS) {
      expect(screen.getByTestId(`dmarc-sender-option-${o.address}`)).toBeTruthy();
    }
  });

  it('passes the chosen address up unchanged', () => {
    const onChange = open();
    fireEvent.click(screen.getByTestId('dmarc-sender-option-postmaster@platform.test'));
    expect(onChange).toHaveBeenCalledWith('postmaster@platform.test');
  });

  it('says so when the stored address is no longer selectable', () => {
    render(
      <DmarcReportSenderSelect
        options={OPTIONS}
        value="postmaster@deleted-tenant.test"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByTestId('dmarc-sender-trigger');
    expect(trigger.textContent).toContain('postmaster@deleted-tenant.test');
    expect(trigger.textContent).toContain('no longer available');
    // And must NOT read as disabled — that is a different state with different
    // consequences (one sends nothing on purpose, the other sends nothing by
    // accident and needs an operator).
    expect(trigger.textContent).not.toContain('Reporting disabled');
  });

  it('states plainly that reporting is off when nothing is selected', () => {
    render(<DmarcReportSenderSelect options={OPTIONS} value={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('dmarc-sender-trigger').textContent).toContain('Reporting disabled');
  });

  it('explains what to do when no address is eligible at all', () => {
    render(<DmarcReportSenderSelect options={[]} value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('dmarc-sender-trigger'));
    expect(screen.getByTestId('dmarc-sender-no-options').textContent).toContain('mail-enabled domain');
    // Disable remains selectable even with an empty list, so the control is
    // never a dead end.
    expect(screen.getByTestId('dmarc-sender-option-disabled')).toBeTruthy();
  });
});
