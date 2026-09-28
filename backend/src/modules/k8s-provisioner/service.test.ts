import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from './k8s-client.js';
import * as schema from '../../db/schema.js';

// The file-manager lifecycle is unit-tested on its own
// (file-manager/k8s-lifecycle.test.ts); here we only assert which node the
// provisioning orchestrator hands it.
const ensureFileManagerRunningMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../file-manager/k8s-lifecycle.js', () => ({
  ensureFileManagerRunning: (...args: unknown[]) => ensureFileManagerRunningMock(...args),
}));
vi.mock('../file-manager/image.js', () => ({
  getFileManagerImage: () => 'ghcr.io/insulahq/file-manager:test',
}));

// ─── Mock K8s API responses ────────────────────────────────────────────────

function createMockK8sTenants(): K8sClients {
  return {
    core: {
      createNamespace: vi.fn().mockResolvedValue({}),
      readNamespace: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { statusCode: 404 })),
      patchNamespace: vi.fn().mockResolvedValue({}),
      createNamespacedResourceQuota: vi.fn().mockResolvedValue({}),
      // Default to "no quota yet", the provisioning case: applyResourceQuota
      // reads the live quota to tell a tiered namespace from a legacy one.
      readNamespacedResourceQuota: vi.fn().mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      ),
      // The tier LimitRange. Present by default: it is the precondition for
      // a quota ceiling, and a mock that 404s it would make every restore
      // test pass by declining to restore.
      readNamespacedLimitRange: vi.fn().mockResolvedValue({}),
      replaceNamespacedResourceQuota: vi.fn().mockResolvedValue({}),
      // Phase F+G fix: applyPVC now reads-then-creates to dodge the
      // ResourceQuota admission firing 403 before the existence check.
      // Mock 404 so the create branch still runs in the existing tests.
      readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      ),
      createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
      createNamespacedServiceAccount: vi.fn().mockResolvedValue({}),
      createNamespacedService: vi.fn().mockResolvedValue({}),
      // Gap G2 node targeting: default to "node exists".
      readNode: vi.fn().mockResolvedValue({ metadata: { name: 'worker-2' } }),
    } as unknown as K8sClients['core'],
    apps: {
      createNamespacedDeployment: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['apps'],
    networking: {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      createNamespacedIngress: vi.fn().mockResolvedValue({}),
    } as unknown as K8sClients['networking'],
  };
}

// ─── Mock DB ────────────────────────────────────────────────────────────────

function createMockDb() {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('K8s Provisioner Service', () => {
  let mockK8s: K8sClients;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockK8s = createMockK8sTenants();
    mockDb = createMockDb();
    ensureFileManagerRunningMock.mockClear();
  });

  describe('provisionNamespace', () => {
    it('should define PROVISION_STEPS with correct step names', async () => {
      const { PROVISION_STEPS } = await import('./service.js');
      expect(PROVISION_STEPS).toContain('Create Namespace');
      expect(PROVISION_STEPS).toContain('Create ResourceQuota');
      expect(PROVISION_STEPS).toContain('Create NetworkPolicy');
      expect(PROVISION_STEPS).toContain('Create PVC');
      expect(PROVISION_STEPS.length).toBeGreaterThanOrEqual(4);
    });

    it('should create namespace with platform + tenant labels', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      expect(mockK8s.core.createNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'tenant-test-ns',
              labels: expect.objectContaining({
                platform: 'k8s-hosting',
                tenant: 'tenant-123',
                // Gate for the backup-rclone-shim ingress NetworkPolicy so
                // in-namespace snapshot/backup Jobs can reach the shim :9000.
                'insula.host/tenant-backup-allowed': 'true',
              }),
            }),
          }),
        }),
      );
    });

    // ADR-036: PSS labels on every tenant namespace.
    it('should set Pod Security Standards labels at creation', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels).toMatchObject({
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
    });

    // ADR-036 backfill behavior: when a namespace already exists, we
    // patch labels (strategic-merge) rather than skipping — that's
    // what makes the platform converge PSS coverage onto pre-ADR-036
    // tenants on the next provisioning touch.
    it('should patch PSS labels onto an existing namespace (backfill path)', async () => {
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123');
      expect(mockK8s.core.createNamespace).not.toHaveBeenCalled();
      expect(mockK8s.core.patchNamespace).toHaveBeenCalledTimes(1);
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as {
        name: string;
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(patchBody.name).toBe('existing-ns');
      expect(patchBody.body.metadata.labels).toMatchObject({
        platform: 'k8s-hosting',
        tenant: 'tenant-123',
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
      // Patch must be strategic-merge so label maps union, not replace.
      const override = patchCall[1] as { _expectedContentType?: string };
      expect(override?._expectedContentType).toBe('application/strategic-merge-patch+json');
    });

    // firewall-toggle PSA fix: enforce level tracks the
    // `allow_host_ports_*` toggles. When the operator enables host
    // ports cluster-wide, every tenant namespace's enforce label
    // must be `privileged` so PSA admits hostPort pods (baseline
    // forbids them outright — that's why pre-fix the platform-api
    // gate let the deploy through but kubelet still rejected the
    // Pod).
    it('should set enforce=privileged when allowHostPorts is true (host-ports toggle on)', async () => {
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123', { allowHostPorts: true });
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels).toMatchObject({
        'pod-security.kubernetes.io/enforce': 'privileged',
        // warn + audit stay at restricted — kubectl + audit log keep
        // flagging restricted violations even when enforce is loosened.
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
    });

    it('should default to enforce=baseline when allowHostPorts is unset (back-compat)', async () => {
      const { applyNamespace } = await import('./service.js');
      // No options arg — same as every pre- caller.
      await applyNamespace(mockK8s, 'tenant-test-ns', 'tenant-123');
      const callBody = (mockK8s.core.createNamespace as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        body: { metadata: { labels: Record<string, string> } };
      };
      expect(callBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
    });

    it('should patch enforce=privileged onto an existing namespace when allowHostPorts is on (backfill path)', async () => {
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123', { allowHostPorts: true });
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(patchBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('privileged');
    });

    it('should patch enforce=baseline onto an existing namespace when allowHostPorts flips off (restore-security path)', async () => {
      // The OFF direction is the operationally important one: the
      // operator just turned host ports OFF and the cluster MUST
      // catch up by tightening enforce back to baseline. A bug here
      // would silently leave tenant namespaces at privileged after
      // the operator believes they've restored the safe default.
      (mockK8s.core.readNamespace as ReturnType<typeof vi.fn>).mockResolvedValue({});
      const { applyNamespace } = await import('./service.js');
      await applyNamespace(mockK8s, 'existing-ns', 'tenant-123', { allowHostPorts: false });
      const patchCall = (mockK8s.core.patchNamespace as ReturnType<typeof vi.fn>).mock.calls[0];
      const patchBody = patchCall[0] as { body: { metadata: { labels: Record<string, string> } } };
      expect(patchBody.body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
    });

    /**
     * ★ A tiered namespace must keep its CPU keys (ADR-062).
     *
     * This function writes the LEGACY shape — plan `requests.cpu`, no
     * `limits.cpu` — and EVERY caller re-applies it: provisioning, the
     * boot-time reconciler, a plan edit (which fans out to every tenant on
     * that plan) and a tenant limit edit. Against a migrated namespace that
     * silently removed the burst ceiling the migration had installed.
     *
     * Observed on production: a plan edit wiped the ceiling from the nine
     * tenants migrated before it. The other twenty survived only because
     * nothing had touched their quota yet — the next API restart would have
     * taken all thirty, since the boot reconciler sweeps every tenant.
     */
    it('preserves the CPU ceiling and tiered request of a migrated namespace', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '110m', 'limits.cpu': '4', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' });

      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;

      // The ceiling survives, and requests.cpu stays the TIERED figure —
      // under tiering the plan's cpu_limit does not govern requests at all.
      expect(hard['limits.cpu']).toBe('4');
      expect(hard['requests.cpu']).toBe('110m');
      // Memory still follows the plan; the tier model changes nothing there.
      expect(hard['requests.memory']).toBe('4Gi');
      expect(hard['limits.memory']).toBe('4Gi');
    });

    // A legacy namespace is untouched by the above — plan values still win.
    it('still writes the plan CPU for a namespace that was never migrated', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '1', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['requests.cpu']).toBe('0.25');
      expect(hard['limits.cpu']).toBeUndefined();
    });

    // Provisioning a brand-new tenant: nothing to read, plan values apply.
    it('writes the plan CPU when the quota does not exist yet', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP-Code: 404'));
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['requests.cpu']).toBe('0.25');
      expect(hard['limits.cpu']).toBeUndefined();
    });

    // The repair direction: ten production namespaces had already lost their
    // ceiling before the write above became tier-aware. The boot sweep knows
    // they are tiered and hands the ceiling back.
    it('restores a MISSING ceiling on a tiered tenant when the caller supplies one', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '0.25', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 4 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBe('4');
      // Left where it is. Only the migration can size this from live pods,
      // and the plan value it currently holds is a cap, not a reservation.
      expect(hard['requests.cpu']).toBe('0.25');
    });

    it('never overwrites a ceiling that is already there', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '110m', 'limits.cpu': '2', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 8 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBe('2');
    });

    it('does not invent a ceiling for a namespace being provisioned', async () => {
      // Neither object exists yet. The LimitRange is the precondition for a
      // ceiling and the honest test of whether a namespace is tiered, so a
      // brand-new one gets the legacy shape whatever the database says.
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP-Code: 404'));
      (mockK8s.core.readNamespacedLimitRange as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      );
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 4 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBeUndefined();
    });

    // ── from review ───────────────────────────────────────────────────────
    it('REFUSES to write when the quota cannot be read for any reason but 404', async () => {
      // An unreadable API is not an absent quota. Swallowing this returned
      // null, the caller wrote the legacy shape, and upsertQuota's fallback
      // is a full-object REPLACE — which deletes limits.cpu. The production
      // incident, re-armed behind a transient blip.
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 500'), { statusCode: 500 }),
      );
      const { applyResourceQuota } = await import('./service.js');
      await expect(applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }))
        .rejects.toThrow(/500/);
      expect(mockK8s.core.createNamespacedResourceQuota).not.toHaveBeenCalled();
      expect(mockK8s.core.replaceNamespacedResourceQuota).not.toHaveBeenCalled();
    });

    it('drops a stray ceiling from a tenant the database calls legacy', async () => {
      // Nothing else removes one, and a legacy pod declares no CPU limit —
      // so a ceiling left here refuses every deploy the tenant makes.
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '110m', 'limits.cpu': '4', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'legacy' } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBeUndefined();
      expect(hard['requests.cpu']).toBe('0.25');
    });

    it('will not restore a ceiling over a namespace with no LimitRange', async () => {
      // A revert that died after removing the LimitRange and before marking
      // the tenant legacy. With a ceiling and no LimitRange, every pod that
      // does not declare a CPU limit is refused — which is every legacy pod.
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '0.25', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      (mockK8s.core.readNamespacedLimitRange as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      );
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 4 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBeUndefined();
    });

    it('will not write a ceiling of zero, which would freeze the namespace', async () => {
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        spec: { hard: { 'requests.cpu': '0.25', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
      });
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 0 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBeUndefined();
    });

    it('rebuilds a DELETED quota with its ceiling when the LimitRange is still there', async () => {
      // namespace-integrity repair. The quota object is gone; the namespace
      // is otherwise intact and its pods carry limits, so recreating it in
      // the legacy shape would leave the backstop off until the next boot.
      (mockK8s.core.readNamespacedResourceQuota as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      );
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '0.25', memory: '4', storage: '50' }, { cpuModel: { mode: 'tiered', ceilingCores: 4 } });
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      const pod = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const hard = (pod![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard;
      expect(hard['limits.cpu']).toBe('4');
      // Nothing live to preserve, so requests.cpu falls back to the plan —
      // a cap above the tier sum, which the next migration step resizes.
      expect(hard['requests.cpu']).toBe('0.25');
    });

    it('should create TWO ResourceQuotas: a Pod-scoped one (CPU/memory) + an unscoped storage one', async () => {
      const { applyResourceQuota } = await import('./service.js');
      await applyResourceQuota(mockK8s, 'test-ns', { cpu: '2', memory: '4', storage: '50' });
      // K8s rejects requests.storage under a PriorityClass scope
      // ("unsupported scope applied to resource"), so we split:
      //   - <ns>-quota          : PriorityClass=tenant-default → counts cpu/memory of tenant Pods
      //   - <ns>-storage-quota  : unscoped → namespace-wide PVC budget
      const calls = (mockK8s.core.createNamespacedResourceQuota as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(2);
      const podCall = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-quota');
      const storageCall = calls.find((c) => (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === 'test-ns-storage-quota');
      expect(podCall).toBeDefined();
      expect(storageCall).toBeDefined();
      // Asymmetric QoS (ADR-037): CPU enforced on `requests.cpu`
      // (pods burst freely), memory enforced on both axes (Guaranteed).
      const podSpec = (podCall![0] as { body: { spec: { hard: Record<string, string>; scopeSelector: object } } }).body.spec;
      expect(podSpec).toMatchObject({
        hard: {
          'requests.cpu': '2',
          'requests.memory': '4Gi',
          'limits.memory': '4Gi',
        },
        scopeSelector: {
          matchExpressions: [
            { scopeName: 'PriorityClass', operator: 'In', values: ['tenant-default'] },
          ],
        },
      });
      // Critically: no `limits.cpu` key — that's what allows CPU bursting.
      expect(podSpec.hard).not.toHaveProperty('limits.cpu');
      expect((storageCall![0] as { body: { spec: { hard: Record<string, string> } } }).body.spec.hard).toEqual({
        'requests.storage': '50Gi',
      });
    });

    it('should create six NetworkPolicies: deny ingress + intra-ns + platform-api + egress + platform-services-egress + backup-jobs-egress', async () => {
      const { applyNetworkPolicy } = await import('./service.js');
      await applyNetworkPolicy(mockK8s, 'test-ns');
      expect(mockK8s.networking.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(6);

      const mockFn = mockK8s.networking.createNamespacedNetworkPolicy as unknown as ReturnType<typeof vi.fn>;
      const calls = mockFn.mock.calls as Array<[{ body: { metadata: { name: string }; spec: { ingress?: Array<{ _from?: unknown[] }>; policyTypes: string[] } } }]>;
      const names = calls.map(c => c[0].body.metadata.name).sort();
      expect(names).toEqual(['allow-backup-jobs-egress', 'allow-intra-namespace', 'allow-platform-api', 'allow-platform-services-egress', 'default-deny-ingress', 'tenant-egress']);

      // The intra-namespace rule is the critical one for multi-component
      // apps — without it, default-deny-ingress blocks wordpress → mariadb.
      const intra = calls.find(c => c[0].body.metadata.name === 'allow-intra-namespace')![0].body;
      expect(intra.spec.ingress![0]._from).toEqual([{ podSelector: {} }]);

      // Regression guard: the cross-tenant pod-CIDR ipBlock must be gone.
      const deny = calls.find(c => c[0].body.metadata.name === 'default-deny-ingress')![0].body;
      expect(JSON.stringify(deny.spec)).not.toContain('10.42.0.0/16');

      // The new default-deny EGRESS policy is present.
      const egress = calls.find(c => c[0].body.metadata.name === 'tenant-egress')![0].body;
      expect(egress.spec.policyTypes).toEqual(['Egress']);
    });

    it('should create PVC with correct storage class and size', async () => {
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'test-ns', '50', 'local-path');
      expect(mockK8s.core.createNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'test-ns-storage',
            }),
            spec: expect.objectContaining({
              storageClassName: 'local-path',
              resources: { requests: { storage: '50Gi' } },
            }),
          }),
        }),
      );
    });

    it('should label new tenant PVCs into the Longhorn default backup group', async () => {
      // Silent-footgun guard: every fresh tenant PVC must carry the
      // recurring-job-group label so Longhorn's backup schedule picks
      // it up. Missing label = silently excluded from backups.
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'tenant-fresh', '10', 'longhorn');
      const [call] = mockK8s.core.createNamespacedPersistentVolumeClaim.mock.calls;
      const labels = call[0].body.metadata.labels;
      expect(labels['recurring-job-group.longhorn.io/default']).toBe('enabled');
      expect(labels['app.kubernetes.io/part-of']).toBe('hosting-platform');
      expect(labels['app.kubernetes.io/component']).toBe('tenant-storage');
    });

    it('should stamp canonical platform/* labels for the PVC→PV mirror reconciler', async () => {
      // The PV name is auto-generated by CSI external-provisioner and
      // looks like `pvc-<uuid>`. Without these labels operators looking
      // at `kubectl get pv` or the Longhorn UI cannot tell which volume
      // belongs to which tenant. The storage-policy reconciler mirrors
      // these from PVC → bound PV at steady state.
      const { applyPVC } = await import('./service.js');
      await applyPVC(mockK8s, 'tenant-acme-abc12345', '10', 'longhorn');
      const [call] = mockK8s.core.createNamespacedPersistentVolumeClaim.mock.calls;
      const labels = call[0].body.metadata.labels;
      expect(labels['platform/role']).toBe('tenant-storage');
      expect(labels['platform/owner']).toBe('tenant-abc12345');
      expect(labels['platform/canonical-name']).toBe('tenant-acme-abc12345-storage');
      expect(labels['platform/managed-by']).toBe('platform-api');
    });
  });

  describe('runProvisionNamespace — file-manager node pin (gap G2)', () => {
    // Regression cover for the file-manager/workload split-brain: the
    // tenant's RWO PVC can only attach on ONE node, so the file-manager
    // MUST land on the same node the deployment reconciler pins workloads
    // to (tenants.nodeName). Before this, only ProvisionOptions.targetNode
    // was threaded through — and the ONLY caller that sets it is DR
    // recovery, so every normally-created tenant got an unpinned FM that
    // could grab the PVC on another node and deadlock every workload with
    // `Multi-Attach error` (observed on a 3-node staging cluster).
    //
    // These assert the ARGUMENT the orchestrator passes; the pinning
    // behaviour itself is covered in file-manager/k8s-lifecycle.test.ts.
    function makeProvisionDb(tenantRow: Record<string, unknown>) {
      const planRow = { id: 'plan-1', cpuLimit: '1', memoryLimit: '1', storageLimit: '10' };
      return {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation((table: unknown) => ({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(async () => {
                if (table === schema.tenants) return [tenantRow];
                if (table === schema.hostingPlans) return [planRow];
                // provisioningTasks → mirrorProvisioningToTaskTracker
                // early-returns on a missing/startedBy-less row.
                return [];
              }),
            }),
          })),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
    }

    function fmPinArg(): string | undefined {
      const call = (ensureFileManagerRunningMock as ReturnType<typeof vi.fn>).mock.calls[0];
      return call?.[4] as string | undefined;
    }

    async function provision(tenantRow: Record<string, unknown>, options?: { targetNode?: string }) {
      const { runProvisionNamespace } = await import('./service.js');
      const db = makeProvisionDb(tenantRow);
      await runProvisionNamespace(
        db as unknown as Parameters<typeof runProvisionNamespace>[0],
        mockK8s,
        'task-1',
        'tenant-123',
        options,
      );
    }

    const baseTenant = {
      id: 'tenant-123',
      planId: 'plan-1',
      kubernetesNamespace: 'tenant-acme-1234',
      storageTier: 'local' as const,
      nodeName: null as string | null,
      cpuLimitOverride: null,
      memoryLimitOverride: null,
      storageLimitOverride: null,
    };

    it('pins the file-manager to tenants.nodeName chosen by the operator at tenant-create', async () => {
      // THE REGRESSION: operator picked a node in the create form → it lands
      // on tenants.nodeName, NOT ProvisionOptions.targetNode. FM must still pin.
      await provision({ ...baseTenant, nodeName: 'worker-2' });
      expect(fmPinArg()).toBe('worker-2');
    });

    it('pins the file-manager to an explicit ProvisionOptions.targetNode (DR-recover path)', async () => {
      await provision({ ...baseTenant, nodeName: null }, { targetNode: 'worker-2' });
      expect(fmPinArg()).toBe('worker-2');
    });

    it('leaves the file-manager unpinned when the tenant has no node (HA tier, scheduler picks)', async () => {
      await provision({ ...baseTenant, storageTier: 'ha', nodeName: null });
      expect(fmPinArg()).toBeUndefined();
    });
  });

  describe('applyTargetNodePlacement (gap G2 node targeting)', () => {
    // Focused DB mock that records every `.set()` payload so we can assert
    // whether tenants.nodeName was persisted (and that it was NOT persisted
    // when validation fails).
    function makeRecordingDb() {
      const updateSets: Array<Record<string, unknown>> = [];
      const db = {
        updateSets,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            updateSets.push(data);
            return { where: vi.fn().mockResolvedValue(undefined) };
          }),
        }),
      };
      return db;
    }

    it('validates then persists tenants.nodeName when the target node exists', async () => {
      const { applyTargetNodePlacement } = await import('./service.js');
      const db = makeRecordingDb();
      (mockK8s.core.readNode as ReturnType<typeof vi.fn>).mockResolvedValue({ metadata: { name: 'worker-2' } });

      await applyTargetNodePlacement(
        db as unknown as Parameters<typeof applyTargetNodePlacement>[0],
        mockK8s,
        'tenant-123',
        'worker-2',
      );

      expect(mockK8s.core.readNode).toHaveBeenCalledWith(expect.objectContaining({ name: 'worker-2' }));
      expect(db.updateSets).toEqual([{ nodeName: 'worker-2' }]);
    });

    it('throws TARGET_NODE_NOT_FOUND (404) and does NOT mutate when the node is missing', async () => {
      const { applyTargetNodePlacement } = await import('./service.js');
      const { ApiError } = await import('../../shared/errors.js');
      const db = makeRecordingDb();
      (mockK8s.core.readNode as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      );

      await expect(
        applyTargetNodePlacement(
          db as unknown as Parameters<typeof applyTargetNodePlacement>[0],
          mockK8s,
          'tenant-123',
          'ghost-node',
        ),
      ).rejects.toMatchObject({ code: 'TARGET_NODE_NOT_FOUND', status: 404 });

      // Validation gates the persist — no DB write may happen on a bad node.
      expect(db.update).not.toHaveBeenCalled();
      expect(db.updateSets).toEqual([]);

      // And it really is an ApiError (renders the operator-facing envelope).
      (mockK8s.core.readNode as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }),
      );
      await expect(
        applyTargetNodePlacement(
          db as unknown as Parameters<typeof applyTargetNodePlacement>[0],
          mockK8s,
          'tenant-123',
          'ghost-node',
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it('propagates a non-404 k8s error unchanged (transient API failure ≠ node-not-found)', async () => {
      const { applyTargetNodePlacement } = await import('./service.js');
      const db = makeRecordingDb();
      (mockK8s.core.readNode as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('HTTP-Code: 500\nMessage: apiserver unavailable'), { statusCode: 500 }),
      );

      await expect(
        applyTargetNodePlacement(
          db as unknown as Parameters<typeof applyTargetNodePlacement>[0],
          mockK8s,
          'tenant-123',
          'worker-2',
        ),
      ).rejects.toThrow(/500/);
      // A masked "not found" here would persist a pin we never verified.
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('buildStepsLog', () => {
    it('should initialize all steps as pending', async () => {
      const { buildStepsLog, PROVISION_STEPS } = await import('./service.js');
      const log = buildStepsLog(PROVISION_STEPS);
      expect(log).toHaveLength(PROVISION_STEPS.length);
      for (const step of log) {
        expect(step.status).toBe('pending');
        expect(step.startedAt).toBeNull();
        expect(step.completedAt).toBeNull();
      }
    });
  });

  describe('updateStepStatus', () => {
    it('should mark a step as running with timestamp', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      const log = buildStepsLog(PROVISION_STEPS);
      const updated = updateStepStatus(log, 'Create Namespace', 'running');
      const step = updated.find(s => s.name === 'Create Namespace');
      expect(step?.status).toBe('running');
      expect(step?.startedAt).toBeTruthy();
    });

    it('should mark a step as completed with timestamp', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      let log = buildStepsLog(PROVISION_STEPS);
      log = updateStepStatus(log, 'Create Namespace', 'running');
      log = updateStepStatus(log, 'Create Namespace', 'completed');
      const step = log.find(s => s.name === 'Create Namespace');
      expect(step?.status).toBe('completed');
      expect(step?.completedAt).toBeTruthy();
    });

    it('should mark a step as failed with error message', async () => {
      const { buildStepsLog, updateStepStatus, PROVISION_STEPS } = await import('./service.js');
      let log = buildStepsLog(PROVISION_STEPS);
      log = updateStepStatus(log, 'Create PVC', 'failed', 'Storage class not found');
      const step = log.find(s => s.name === 'Create PVC');
      expect(step?.status).toBe('failed');
      expect(step?.error).toBe('Storage class not found');
    });
  });

  describe('formatK8sError', () => {
    it('extracts the k8s Status message from an embedded response body', async () => {
      const { formatK8sError } = await import('./service.js');
      // Shape thrown by @kubernetes/client-node v1.4 on a 403 — the body is
      // a JSON-stringified Status object, quotes are backslash-escaped.
      const body = JSON.stringify({
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        message: 'resourcequotas is forbidden: User "system:serviceaccount:platform:platform-api" cannot create resource "resourcequotas" in the namespace "tenant-x"',
        reason: 'Forbidden',
        code: 403,
      });
      const raw = `HTTP-Code: 403\nMessage: Unknown API Status Code!\nBody: ${JSON.stringify(body)}\nHeaders: {"audit-id":"abc"}`;
      const out = formatK8sError(new Error(raw));
      expect(out).toContain('resourcequotas is forbidden');
      expect(out).toContain('HTTP 403');
      expect(out).not.toContain('audit-id');
      expect(out).not.toContain('Headers:');
    });

    it('falls back to first line when the error has no parsable body', async () => {
      const { formatK8sError } = await import('./service.js');
      const err = new Error('Connection refused\nstack trace...');
      expect(formatK8sError(err)).toBe('Connection refused');
    });

    it('truncates very long single-line messages', async () => {
      const { formatK8sError } = await import('./service.js');
      const err = new Error('x'.repeat(1000));
      const out = formatK8sError(err);
      expect(out.length).toBeLessThanOrEqual(501);
      expect(out.endsWith('…')).toBe(true);
    });

    it('handles non-Error values', async () => {
      const { formatK8sError } = await import('./service.js');
      expect(formatK8sError('boom')).toBe('boom');
      expect(formatK8sError(42)).toBe('42');
    });
  });
});
