import { and, eq } from 'drizzle-orm';
import { deployments } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * Scale K8s Deployments for all custom deployments in a namespace.
 *
 * Uses the `platform.phoenix-host.net/deployment-id=<id>` label that
 * the custom k8s-deployer stamps on every Deployment it owns (single
 * service or multi-service compose stack). Works across all services
 * in a stack without needing to enumerate service names.
 */
async function scaleCustomK8sDeployments(
  ctx: HookCtx,
  replicas: 0 | 1,
): Promise<void> {
  const rows = await ctx.db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(
      eq(deployments.clientId, ctx.clientId),
      eq(deployments.source, 'custom'),
    ));

  for (const row of rows) {
    const labelSelector = `platform.phoenix-host.net/deployment-id=${row.id}`;
    const list = await (ctx.k8s.apps as unknown as {
      listNamespacedDeployment: (args: { namespace: string; labelSelector: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
    }).listNamespacedDeployment({ namespace: ctx.namespace, labelSelector });

    for (const item of list.items ?? []) {
      const name = item.metadata?.name;
      if (!name) continue;
      try {
        const current = await (ctx.k8s.apps as unknown as {
          readNamespacedDeploymentScale: (args: { name: string; namespace: string }) => Promise<Record<string, unknown>>;
        }).readNamespacedDeploymentScale({ name, namespace: ctx.namespace });
        const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
        await (ctx.k8s.apps as unknown as {
          replaceNamespacedDeploymentScale: (args: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
        }).replaceNamespacedDeploymentScale({
          name, namespace: ctx.namespace,
          body: { ...scale, spec: { ...scale.spec, replicas } },
        });
      } catch {
        // 404 → already gone; skip silently.
      }
    }
  }
}

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition === 'suspended' || ctx.transition === 'archived') {
    await scaleCustomK8sDeployments(ctx, 0);
    return { status: 'ok', detail: 'scaled custom K8s Deployments to 0' };
  }
  if (ctx.transition === 'active' || ctx.transition === 'restored') {
    await scaleCustomK8sDeployments(ctx, 1);
    return { status: 'ok', detail: 'scaled custom K8s Deployments to 1' };
  }
  return { status: 'noop', detail: 'transition does not affect custom deployment replicas' };
}

export const customDeploymentsScaleHook: LifecycleHook = {
  name: 'k8s-custom-deployments-scale',
  transitions: ['suspended', 'archived', 'active', 'restored'],
  order: 250,
  blocking: 'continue',
  run: runImpl,
};

let _registered = false;
export function registerCustomDeploymentsScaleHook(): void {
  if (_registered) return;
  registerLifecycleHook(customDeploymentsScaleHook);
  _registered = true;
}
