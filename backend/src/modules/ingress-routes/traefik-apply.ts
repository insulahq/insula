/**
 * Apply / delete helpers for Traefik IngressRoute + Middleware CRDs
 * via the Kubernetes CustomObjectsApi.
 *
 * Mirrors the create-or-replace pattern used in
 * system-settings/ingress-reconciler.ts. SSA (server-side apply) would
 * be more conventional but @kubernetes/client-node's content-type
 * handling on CustomObjectsApi.patchNamespacedCustomObject is fragile
 * across versions, so a read-then-replace is the most portable shape.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  INGRESSROUTE_PLURAL,
  MIDDLEWARE_PLURAL,
} from './traefik-types.js';
import type { IngressRouteBody, MiddlewareBody } from './traefik-types.js';

export function isK8sNotFound(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  const e = err as { statusCode?: number; code?: number };
  if (e?.statusCode === 404) return true;
  if (e?.code === 404) return true;
  return false;
}

interface ApplyArgs {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: Record<string, unknown>;
}

async function createOrReplaceCustomObject(
  custom: k8s.CustomObjectsApi,
  args: ApplyArgs,
): Promise<void> {
  try {
    const existing = await custom.getNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      name: args.name,
    });
    const meta = ((existing as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
    const replaceBody = {
      ...args.body,
      metadata: {
        ...(args.body.metadata as Record<string, unknown>),
        resourceVersion: meta.resourceVersion,
      },
    };
    await custom.replaceNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      name: args.name,
      body: replaceBody,
    });
  } catch (err: unknown) {
    if (!isK8sNotFound(err)) throw err;
    await custom.createNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      body: args.body,
    });
  }
}

export async function applyIngressRoute(
  custom: k8s.CustomObjectsApi,
  body: IngressRouteBody,
): Promise<void> {
  await createOrReplaceCustomObject(custom, {
    group: TRAEFIK_GROUP,
    version: TRAEFIK_VERSION,
    namespace: body.metadata.namespace,
    plural: INGRESSROUTE_PLURAL,
    name: body.metadata.name,
    body: body as unknown as Record<string, unknown>,
  });
}

export async function applyMiddleware(
  custom: k8s.CustomObjectsApi,
  body: MiddlewareBody,
): Promise<void> {
  await createOrReplaceCustomObject(custom, {
    group: TRAEFIK_GROUP,
    version: TRAEFIK_VERSION,
    namespace: body.metadata.namespace,
    plural: MIDDLEWARE_PLURAL,
    name: body.metadata.name,
    body: body as unknown as Record<string, unknown>,
  });
}

export async function deleteIngressRoute(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await custom.deleteNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: INGRESSROUTE_PLURAL,
      name,
    });
  } catch (err: unknown) {
    if (!isK8sNotFound(err)) throw err;
  }
}

export async function deleteMiddleware(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await custom.deleteNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: MIDDLEWARE_PLURAL,
      name,
    });
  } catch (err: unknown) {
    if (!isK8sNotFound(err)) throw err;
  }
}

export async function listMiddlewares(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  labelSelector?: string,
): Promise<Array<{ name: string; labels: Record<string, string> }>> {
  try {
    const res = await custom.listNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: MIDDLEWARE_PLURAL,
      ...(labelSelector ? { labelSelector } : {}),
    });
    const items = ((res as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> }).items) ?? [];
    return items
      .map((it) => ({
        name: it.metadata?.name ?? '',
        labels: it.metadata?.labels ?? {},
      }))
      .filter((it) => it.name !== '');
  } catch (err: unknown) {
    if (isK8sNotFound(err)) return [];
    throw err;
  }
}

export async function listIngressRoutes(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  labelSelector?: string,
): Promise<Array<{ name: string; labels: Record<string, string> }>> {
  try {
    const res = await custom.listNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace,
      plural: INGRESSROUTE_PLURAL,
      ...(labelSelector ? { labelSelector } : {}),
    });
    const items = ((res as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> }).items) ?? [];
    return items
      .map((it) => ({
        name: it.metadata?.name ?? '',
        labels: it.metadata?.labels ?? {},
      }))
      .filter((it) => it.name !== '');
  } catch (err: unknown) {
    if (isK8sNotFound(err)) return [];
    throw err;
  }
}
