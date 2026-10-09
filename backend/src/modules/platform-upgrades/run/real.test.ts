import { describe, it, expect } from 'vitest';
import { servicesRepinFor } from './real.js';

describe('servicesRepinFor', () => {
  it("re-pins exactly the run's version, as a decided upgrade — never re-deciding from what is available now", () => {
    // An automatic run decided 2026.10.8; a newer 2026.10.9 verified while its nodes
    // prepared must not become the services' target.
    expect(servicesRepinFor({ toVersion: '2026.10.8' })).toEqual({ mode: 'manual', requestedVersion: '2026.10.8' });
  });
});
