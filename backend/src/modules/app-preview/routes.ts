/**
 * App preview routes.
 *
 *   POST /tenants/:tenantId/deployments/:id/preview-session   (Bearer)
 *       → mints a short-lived HMAC proxy URL + the target list
 *   ALL  /preview/:token/*                                     (token-authed)
 *       → streams to the target ClusterIP Service
 *
 * Security model (the proxied content is TENANT-CONTROLLED):
 *   - Every proxied response gets `Content-Security-Policy: sandbox
 *     allow-scripts allow-forms` — the browser treats the content as an
 *     opaque origin even when the URL is opened top-level, so tenant JS
 *     can never touch the panel's cookies/localStorage.
 *   - Inbound `Cookie` / `Authorization` headers are STRIPPED — panel
 *     credentials never reach the tenant workload.
 *   - Outbound `Set-Cookie` is STRIPPED — a workload cannot plant
 *     cookies on the panel origin.
 *   - The token pins one (namespace, service, port) tuple; the proxy can
 *     reach nothing else (no SSRF surface — the target never comes from
 *     the request path/query).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import http, { type IncomingMessage } from 'node:http';
import { authenticate, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { createPreviewSessionRequestSchema } from '@insula/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { resolvePreviewTargets } from './service.js';
import { mintPreviewToken, verifyPreviewToken, type PreviewTokenPayload } from './token.js';

const PREVIEW_URL_PREFIX = '/api/v1/preview';
// The browser-side containment for tenant-controlled content — applied to
// EVERY proxied response, including our own error pages.
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms';
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Hop-by-hop + credential headers never forwarded to the workload. */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'authorization', 'connection', 'keep-alive', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization',
  'proxy-connection', 'expect',
]);
/** Headers never passed back from the workload to the browser. */
const STRIP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'trailer',
]);

export async function appPreviewSessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // POST /api/v1/tenants/:tenantId/deployments/:id/preview-session
  app.post('/tenants/:tenantId/deployments/:id/preview-session', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const parsed = createPreviewSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0]?.message ?? 'Invalid body', 400);
    }

    const resolved = await resolvePreviewTargets(app.db, tenantId, id);
    const pick =
      parsed.data.serviceName != null && parsed.data.port != null
        ? resolved.targets.find(
            (t) => t.serviceName === parsed.data.serviceName && t.port === parsed.data.port,
          )
        : resolved.targets.find((t) => t.primary) ?? resolved.targets[0];
    if (!pick) {
      throw new ApiError('PREVIEW_TARGET_NOT_FOUND', 'Requested preview target does not exist on this deployment', 404);
    }

    const { token, expiresAt } = mintPreviewToken(
      { ns: resolved.namespace, svc: pick.serviceName, port: pick.port },
      Date.now(),
    );
    request.log.info(
      { tenantId, deploymentId: id, service: pick.serviceName, port: pick.port },
      'app-preview: session minted',
    );
    return success({
      url: `${PREVIEW_URL_PREFIX}/${token}/`,
      expiresAt,
      target: pick,
      targets: resolved.targets,
    });
  });
}

export async function appPreviewProxyRoutes(app: FastifyInstance): Promise<void> {
  // The proxy streams request bodies verbatim — no body parsing in this
  // scope (a JSON parser would consume the stream and mangle uploads).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  // Bare token (no trailing slash): redirect so the app's relative URLs
  // resolve under the token prefix.
  app.get('/preview/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    return reply.redirect(`${PREVIEW_URL_PREFIX}/${encodeURIComponent(token)}/`);
  });

  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/preview/:token/*',
    handler: previewProxyHandler,
  });
}

async function previewProxyHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token } = request.params as { token: string; '*': string };
  const payload = verifyPreviewToken(token, Date.now());
  if (!payload) {
    return sendPreviewErrorPage(reply, 403, 'Preview session expired',
      'This preview link has expired. Close the preview and open it again.');
  }

  const wildcard = (request.params as Record<string, string>)['*'] ?? '';
  const qIndex = request.raw.url?.indexOf('?') ?? -1;
  const query = qIndex >= 0 ? request.raw.url!.slice(qIndex) : '';
  const upstreamPath = `/${wildcard}${query}`;

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(request.raw.headers)) {
    if (v === undefined || STRIP_REQUEST_HEADERS.has(k)) continue;
    headers[k] = v;
  }

  reply.hijack();
  await new Promise<void>((resolve) => {
    const upstream = http.request(
      {
        hostname: `${payload.svc}.${payload.ns}.svc.cluster.local`,
        port: payload.port,
        path: upstreamPath,
        method: request.raw.method,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || STRIP_RESPONSE_HEADERS.has(k)) continue;
          out[k] = v;
        }
        // Path-absolute redirects must stay inside the token prefix.
        const loc = res.headers.location;
        if (typeof loc === 'string' && loc.startsWith('/')) {
          out.location = `${PREVIEW_URL_PREFIX}/${token}${loc}`;
        }
        out['content-security-policy'] = SANDBOX_CSP;
        out['x-robots-tag'] = 'noindex, nofollow';
        reply.raw.writeHead(res.statusCode ?? 502, out);
        res.pipe(reply.raw);
        res.on('end', resolve);
        res.on('error', () => {
          try { reply.raw.end(); } catch { /* already closed */ }
          resolve();
        });
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      request.log.info({ err: err.message, svc: payload.svc, ns: payload.ns, port: payload.port },
        'app-preview: upstream unreachable');
      writeErrorPageRaw(reply, 502, 'App not reachable yet',
        'The app did not answer. It may still be starting — wait a few seconds and use the Refresh button.');
      resolve();
    });
    request.raw.pipe(upstream);
    request.raw.on('error', () => upstream.destroy());
  });
}

function previewErrorHtml(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb;color:#111827}
@media(prefers-color-scheme:dark){body{background:#111827;color:#f9fafb}}
.card{max-width:26rem;text-align:center;padding:2rem}h1{font-size:1.1rem}p{font-size:.9rem;color:#6b7280}</style>
</head><body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

function sendPreviewErrorPage(reply: FastifyReply, status: number, title: string, detail: string): void {
  void reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', SANDBOX_CSP)
    .header('x-robots-tag', 'noindex, nofollow')
    .send(previewErrorHtml(title, detail));
}

function writeErrorPageRaw(reply: FastifyReply, status: number, title: string, detail: string): void {
  try {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': SANDBOX_CSP,
        'x-robots-tag': 'noindex, nofollow',
      });
    }
    reply.raw.end(previewErrorHtml(title, detail));
  } catch { /* connection already gone */ }
}
