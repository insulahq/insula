import { describe, it, expect } from 'vitest';
import { normalizeApexInput } from './service.js';

describe('normalizeApexInput', () => {
  it('accepts and lowercases a valid FQDN, stripping trailing dots', () => {
    expect(normalizeApexInput('Brand.Example.COM')).toBe('brand.example.com');
    expect(normalizeApexInput('testing-rename.phoenix-host.net.')).toBe('testing-rename.phoenix-host.net');
    expect(normalizeApexInput('  a.b.example.org  ')).toBe('a.b.example.org');
  });

  it('rejects empty / single-label / invalid domains', () => {
    for (const bad of ['', '   ', 'localhost', 'no spaces.com', 'bad_underscore.com', '-leading.com', '.example.com']) {
      expect(() => normalizeApexInput(bad)).toThrowError();
    }
  });
});
