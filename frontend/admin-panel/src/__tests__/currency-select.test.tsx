import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CurrencySelect from '../components/CurrencySelect';

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
