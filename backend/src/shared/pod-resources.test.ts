import { describe, it, expect } from 'vitest';
import { effectivePodRequest } from './pod-resources.js';

/**
 * The rule under test is Kubernetes', not ours: a pod is charged
 * `max(sum(containers), max(initContainers))`, and it is charged that for the
 * pod's whole lifetime — long after the init container has exited.
 *
 * Every fixture below is dimensioned from the production case that exposed the
 * gap (one tenant, 2026-09-19).
 */

const c = (memory: string, cpu = '100m') => ({ resources: { requests: { memory, cpu } } });
const sidecar = (memory: string, cpu = '10m') => ({
  restartPolicy: 'Always',
  resources: { requests: { memory, cpu } },
});

describe('effectivePodRequest', () => {
  it('returns the container sum when no init container is larger', () => {
    const spec = { containers: [c('400Mi')], initContainers: [c('32Mi')] };
    expect(effectivePodRequest(spec, 'memory')).toBeCloseTo(400 / 1024, 6);
  });

  // The bug: a 400Mi MariaDB behind a 512Mi `reset-root-password` init
  // container was charged 512Mi. Our panel summed containers and said 400Mi.
  it('returns the init container when it exceeds the containers', () => {
    const spec = {
      containers: [c('400Mi')],
      initContainers: [c('512Mi'), c('32Mi')],
    };
    expect(effectivePodRequest(spec, 'memory')).toBeCloseTo(512 / 1024, 6);
  });

  // 512Mi (mariadb pod) + 32Mi (website pod) = 544Mi, which is exactly what
  // the ResourceQuota reported while the panel showed 432Mi.
  it('reproduces the production namespace total', () => {
    const mariadb = { containers: [c('400Mi')], initContainers: [c('512Mi'), c('32Mi')] };
    const website = { containers: [c('32Mi')], initContainers: [c('32Mi')] };
    const totalMi =
      (effectivePodRequest(mariadb, 'memory') + effectivePodRequest(website, 'memory')) * 1024;
    expect(Math.round(totalMi)).toBe(544);
  });

  it('sums multiple app containers before comparing', () => {
    const spec = {
      containers: [c('300Mi'), c('300Mi')],
      initContainers: [c('512Mi')],
    };
    expect(Math.round(effectivePodRequest(spec, 'memory') * 1024)).toBe(600);
  });

  it('handles cpu, where tenant containers set a request and no limit (ADR-037)', () => {
    const spec = {
      containers: [{ resources: { requests: { cpu: '100m' } } }],
      initContainers: [{ resources: { requests: { cpu: '500m' } } }],
    };
    expect(effectivePodRequest(spec, 'cpu')).toBeCloseTo(0.5, 6);
  });

  it('falls back to limits when a container declares no request', () => {
    const spec = { containers: [{ resources: { limits: { memory: '256Mi' } } }] };
    expect(Math.round(effectivePodRequest(spec, 'memory') * 1024)).toBe(256);
  });

  describe('sidecars (initContainers with restartPolicy: Always)', () => {
    // A sidecar never exits, so Kubernetes adds it to the app sum rather than
    // treating it as an exclusive peak.
    it('adds a sidecar to the container sum', () => {
      const spec = { containers: [c('400Mi')], initContainers: [sidecar('64Mi')] };
      expect(Math.round(effectivePodRequest(spec, 'memory') * 1024)).toBe(464);
    });

    it('charges a regular init container alongside sidecars started before it', () => {
      const spec = {
        containers: [c('100Mi')],
        initContainers: [sidecar('64Mi'), c('512Mi')],
      };
      // init peak 512 + 64 sidecar = 576 beats app sum 100 + 64 = 164.
      expect(Math.round(effectivePodRequest(spec, 'memory') * 1024)).toBe(576);
    });

    it('ignores a sidecar declared after the init container it does not precede', () => {
      const spec = {
        containers: [c('100Mi')],
        initContainers: [c('200Mi'), sidecar('64Mi')],
      };
      // init peak 200 (no sidecar before it) vs app sum 100 + 64 = 164.
      expect(Math.round(effectivePodRequest(spec, 'memory') * 1024)).toBe(200);
    });
  });

  it('is zero for an absent or empty spec', () => {
    expect(effectivePodRequest(undefined, 'memory')).toBe(0);
    expect(effectivePodRequest({}, 'memory')).toBe(0);
    expect(effectivePodRequest({ containers: [{}] }, 'memory')).toBe(0);
  });
});
