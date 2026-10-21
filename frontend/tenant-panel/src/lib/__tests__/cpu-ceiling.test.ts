import { describe, expect, it } from 'vitest';
import { cpuCeilingCores, cpuCores, formatCpuCeiling } from '../cpu-ceiling';

const svc = (cpuLimit?: string) => ({ image: 'ghcr.io/example/app:1', resources: { cpuRequest: '5m', memoryRequest: '128Mi', ...(cpuLimit ? { cpuLimit } : {}) } });
const custom = (...services: ReturnType<typeof svc>[]) => ({
  source: 'custom' as const,
  customSpec: { services: Object.fromEntries(services.map((s, i) => [`s${i}`, s])) } as never,
});

describe('cpuCeilingCores', () => {
  it('is the plan burst ceiling for a catalog app — never its request', () => {
    expect(cpuCeilingCores({ source: 'catalog', customSpec: null }, 6)).toBe(6);
  });

  it('is the custom spec’s own limit when every service declares one', () => {
    expect(cpuCeilingCores(custom(svc('500m')), 6)).toBe(0.5);
  });

  it('adds a stack’s limits up — the usage it is shown against is the whole app’s', () => {
    expect(cpuCeilingCores(custom(svc('1'), svc('1')), 6)).toBe(2);
    expect(cpuCeilingCores(custom(svc('500m'), svc('2')), 6)).toBe(2.5);
  });

  it('falls back to the plan ceiling when a service has no limit of its own (the LimitRange default applies to it)', () => {
    expect(cpuCeilingCores(custom(svc('500m'), svc()), 6)).toBe(6);
  });

  it('is null with no ceiling to show, so the caller keeps the request', () => {
    expect(cpuCeilingCores({ source: 'catalog', customSpec: null }, null)).toBeNull();
    expect(cpuCeilingCores({ source: 'catalog', customSpec: null }, 0)).toBeNull();
  });
});

describe('cpuCores / formatCpuCeiling', () => {
  it('reads millicores and cores', () => {
    expect(cpuCores('250m')).toBe(0.25);
    expect(cpuCores('1.5')).toBe(1.5);
    expect(cpuCores('')).toBe(0);
  });

  it('reads as cores at one and above, millicores below', () => {
    expect(formatCpuCeiling(6)).toBe('6 cores');
    expect(formatCpuCeiling(1)).toBe('1 core');
    expect(formatCpuCeiling(1.5)).toBe('1.5 cores');
    expect(formatCpuCeiling(0.5)).toBe('500m');
  });
});
