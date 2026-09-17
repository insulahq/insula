import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CurrencySelect from '../components/CurrencySelect';
import { ISO_4217_ACTIVE } from '../lib/iso-4217';

/**
 * The picker used to be a 15-entry <select> with an inert "__custom__" row, so
 * a platform billing in a currency nobody had listed could SEE its own code
 * labelled "Custom" and had no way to choose it. These tests pin the two things
 * that fixes: the list is complete, and it is searchable by name as well as by
 * code — an admin who knows "rand" but not "ZAR" has to be able to find it.
 */
describe('CurrencySelect', () => {
  const open = () => fireEvent.click(screen.getByTestId('currency-select-button'));

  it('shows the selected code with its name', () => {
    render(<CurrencySelect value="EUR" onChange={() => {}} />);
    expect(screen.getByTestId('currency-select-button').textContent).toMatch(/EUR/);
  });

  it('offers currencies far outside the old fifteen', () => {
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    for (const code of ['MXN', 'KES', 'PLN', 'THB']) {
      expect(screen.getByTestId(`currency-option-${code}`)).toBeTruthy();
    }
  });

  /**
   * The runtime list alone is NOT complete, and that is not a theoretical gap:
   * `Intl.supportedValuesOf('currency')` returned 159 codes in the DEV
   * cluster's Chromium and 162 in Node 22 on the same day, and neither
   * included VED — a currency Venezuela circulates. Since the picker has no
   * free-text entry, a code the engine omits is a code the operator cannot
   * choose at all, which is the exact complaint the old 15-entry list drew.
   */
  it('offers every active ISO code, including ones this runtime omits', () => {
    const runtime = new Set(
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [],
    );
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    const missingFromRuntime = ISO_4217_ACTIVE.filter((c) => !runtime.has(c));
    // Guards the test itself: if a future engine ships every ISO code this
    // assertion would silently stop testing anything.
    expect(missingFromRuntime).toContain('VED');
    for (const code of missingFromRuntime) {
      expect(screen.getByTestId(`currency-option-${code}`)).toBeTruthy();
    }
    for (const code of ISO_4217_ACTIVE) {
      expect(screen.getByTestId(`currency-option-${code}`)).toBeTruthy();
    }
  });

  /**
   * The union runs the other way too: a code ISO has retired (HRK, CUC, ZWL)
   * may still be saved on a platform that set it years ago, and dropping it
   * would make that platform's own currency unpickable — the original bug.
   */
  it('keeps codes the runtime knows but ISO has retired', () => {
    const runtime = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
    const retired = runtime.filter((c) => !ISO_4217_ACTIVE.includes(c));
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    for (const code of retired) {
      expect(screen.getByTestId(`currency-option-${code}`)).toBeTruthy();
    }
  });

  it('lists each code exactly once outside the pinned group', () => {
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    const codes = screen
      .getAllByTestId(/^currency-option-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(codes.length).toBe(new Set(codes).size);
  });

  it('searches by name, not only by code', () => {
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    fireEvent.change(screen.getByTestId('currency-select-search'), { target: { value: 'rand' } });
    expect(screen.getByTestId('currency-option-ZAR')).toBeTruthy();
  });

  it('searches by code', () => {
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    fireEvent.change(screen.getByTestId('currency-select-search'), { target: { value: 'jpy' } });
    expect(screen.getByTestId('currency-option-JPY')).toBeTruthy();
  });

  it('reports the chosen code', () => {
    let picked = '';
    render(<CurrencySelect value="USD" onChange={(c) => { picked = c; }} />);
    open();
    fireEvent.change(screen.getByTestId('currency-select-search'), { target: { value: 'MXN' } });
    fireEvent.click(screen.getByTestId('currency-option-MXN'));
    expect(picked).toBe('MXN');
  });

  it('still displays a code the runtime does not know, instead of reading as unset', () => {
    render(<CurrencySelect value="XTS" onChange={() => {}} />);
    expect(screen.getByTestId('currency-select-button').textContent).toMatch(/XTS/);
  });

  it('says so when nothing matches', () => {
    render(<CurrencySelect value="USD" onChange={() => {}} />);
    open();
    fireEvent.change(screen.getByTestId('currency-select-search'), { target: { value: 'zzzzz' } });
    expect(screen.getByText(/No currencies match/)).toBeTruthy();
  });
});
