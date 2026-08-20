/**
 * Cluster DNS resolver settings — read, update, and a non-persisting probe.
 *
 * The probe exists so an operator cannot point the platform at a blackholed
 * upstream and discover it only when domain verification starts failing: the
 * UI tests the candidate servers BEFORE the PUT.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import {
  dnsResolverServerSchema,
  MAX_DNS_RESOLVER_SERVERS,
} from '@insula/api-contracts';
import { z } from 'zod';
import {
  getDnsResolverStatus,
  updateDnsResolverSettings,
  probeDnsResolver,
} from './service.js';

const probeBodySchema = z.object({
  servers: z.array(dnsResolverServerSchema).max(MAX_DNS_RESOLVER_SERVERS).default([]),
});

export async function dnsResolverRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/admin/platform/dns-resolver ─────────────────────────────
  app.get('/admin/platform/dns-resolver', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['DNS Resolver'],
      summary: 'Read the cluster DNS resolver settings',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                mode: { type: 'string' },
                servers: { type: 'array', items: { type: 'string' } },
                effectiveServers: { type: 'array', items: { type: 'string' } },
                hostServers: { type: 'array', items: { type: 'string' } },
                maxServers: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return success(await getDnsResolverStatus(app.db));
  });

  // ─── PUT /api/v1/admin/platform/dns-resolver ─────────────────────────────
  // Bearer-only (the `authenticate` decorator has no cookie fallback), so this
  // mutating route is CSRF-safe by construction.
  app.put('/admin/platform/dns-resolver', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['DNS Resolver'],
      summary: 'Update the cluster DNS resolver settings',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['host', 'custom'] },
          servers: {
            type: 'array',
            maxItems: MAX_DNS_RESOLVER_SERVERS,
            items: { type: 'string' },
          },
        },
      },
    },
  }, async (request) => {
    // Zod (not the JSON-schema above) is the authority: it enforces bare-IP
    // form, the duplicate check, and "custom requires >= 1 server".
    const settings = await updateDnsResolverSettings(app.db, request.body);
    return success(settings);
  });

  // ─── POST /api/v1/admin/platform/dns-resolver/probe ──────────────────────
  // Does NOT persist. An empty list probes the pod's inherited resolver, so
  // the UI can show whether `host` mode currently works too.
  app.post('/admin/platform/dns-resolver/probe', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['DNS Resolver'],
      summary: 'Test candidate DNS upstreams without saving them',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            maxItems: MAX_DNS_RESOLVER_SERVERS,
            items: { type: 'string' },
          },
        },
      },
    },
  }, async (request) => {
    const { servers } = probeBodySchema.parse(request.body ?? {});
    return success(await probeDnsResolver(servers));
  });
}
