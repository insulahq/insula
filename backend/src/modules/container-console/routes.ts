import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import {
  authenticate,
  requireRole,
  requireTenantAccess,
  assertAccessToken,
  type JwtPayload,
} from '../../middleware/auth.js';
import * as deploymentService from '../deployments/service.js';
import {
  fetchPods,
  listDeploymentComponents,
  createKubeConfig,
} from './service.js';

interface ConsoleParams {
  tenantId: string;
  deploymentId: string;
}

interface ConsoleQuery {
  token?: string;
  component?: string;
  tailLines?: string;
  shell?: string;
}

const ALLOWED_SHELLS = new Set(['/bin/sh', '/bin/bash', '/bin/ash']);

function getK8s(app: FastifyInstance) {
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    return createK8sClients(kubeconfigPath);
  } catch {
    return undefined;
  }
}

function getKubeConfig(app: FastifyInstance): k8s.KubeConfig {
  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
  return createKubeConfig(kubeconfigPath);
}

function authenticateWs(app: FastifyInstance, request: FastifyRequest): JwtPayload {
  const query = request.query as ConsoleQuery;
  const token = query.token ?? request.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new ApiError('UNAUTHORIZED', 'Missing authentication token', 401);

  // Phase 3: no denylist check — access tokens are short-lived (30 min)
  // and verified statelessly. WebSocket session lifetime is bounded by
  // the access token's exp anyway.

  try {
    const decoded = app.jwt.verify<JwtPayload>(token);
    // Pre-auth (passkey_2fa) tokens are not session tokens. The WS
    // routes bypass the `authenticate` hook, so assert here too.
    assertAccessToken(decoded);
    return decoded;
  } catch {
    throw new ApiError('UNAUTHORIZED', 'Invalid token', 401);
  }
}

/**
 * Tenant scoping for the WebSocket routes, which cannot use the
 * `requireTenantAccess()` onRequest hook (raw upgrade handlers run
 * before/outside the normal hook chain in the same way the node-terminal
 * WS does).
 *
 * SECURITY (2026-07-28): the previous version read
 *   `user.panel === 'tenant' && user.tenantId && user.tenantId !== tenantId`
 * which FAILS OPEN for any tenant-panel token that carries no `tenantId`
 * claim — the exact hole middleware/auth.ts:requireTenantAccess closed
 * ("Phase 1 hardening … Fail closed"); this local copy never got the fix.
 * Mirror the middleware semantics exactly: a tenant-panel token MUST
 * carry a tenantId, and it MUST equal the requested tenant.
 */
function enforceTenantAccess(user: JwtPayload, tenantId: string): void {
  if (user.panel !== 'tenant') return; // staff — authorized by the role gate
  if (!user.tenantId) {
    throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel tokens must carry a tenantId claim', 403);
  }
  if (user.tenantId !== tenantId) {
    throw new ApiError('FORBIDDEN', 'Access denied to this tenant', 403);
  }
}

/**
 * Roles allowed to observe a tenant's containers (component list, log
 * stream). Deliberately excludes the admin-panel reporting roles
 * `billing` and `read_only`: container logs routinely carry secrets and
 * customer PII, which is not in scope for a billing/reporting seat.
 */
const CONSOLE_READ_ROLES: ReadonlyArray<JwtPayload['role']> = [
  'super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user',
];

export async function containerConsoleRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/v1/tenants/:tenantId/deployments/:deploymentId/components
  //
  // SECURITY (2026-07-28): this route had `authenticate` only — no role
  // gate and no tenant gate — so any authenticated user could enumerate
  // any tenant's pod/container topology by editing the path. It is a
  // plain HTTP route (not a WS upgrade), so it uses the standard
  // middleware hooks rather than the local helpers above.
  app.get('/tenants/:tenantId/deployments/:deploymentId/components', {
    onRequest: [
      authenticate,
      requireRole(...CONSOLE_READ_ROLES),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId, deploymentId } = request.params as ConsoleParams;
    const deployment = await deploymentService.getDeploymentById(app.db, tenantId, deploymentId);
    const namespace = await deploymentService.getTenantNamespace(app.db, tenantId);
    const k8sTenants = getK8s(app);
    if (!k8sTenants) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

    const pods = await fetchPods(k8sTenants, namespace, deployment.name);
    const components = listDeploymentComponents(pods);

    return { data: components };
  });

  // WebSocket: /api/v1/tenants/:tenantId/deployments/:deploymentId/logs/stream
  app.get('/tenants/:tenantId/deployments/:deploymentId/logs/stream', {
    websocket: true,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, (socket, request) => {
    let user: JwtPayload;
    try {
      user = authenticateWs(app, request);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      socket.close(4401, 'Unauthorized');
      return;
    }

    // SECURITY (2026-07-28): the log stream had NO role check, so the
    // admin-panel reporting roles (`billing`, `read_only`) — which pass
    // enforceTenantAccess because panel !== 'tenant' — could stream live
    // container logs for every tenant. Logs routinely carry secrets and
    // customer PII. Mirror the /components gate.
    if (!CONSOLE_READ_ROLES.includes(user.role)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Log access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }

    const { tenantId, deploymentId } = request.params as ConsoleParams;

    try {
      enforceTenantAccess(user, tenantId);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }
    const query = request.query as ConsoleQuery;
    const componentFilter = query.component;
    const tailLines = Math.min(parseInt(query.tailLines ?? '100', 10) || 100, 1000);

    const streams: PassThrough[] = [];
    let closed = false;

    const cleanup = () => {
      closed = true;
      for (const s of streams) s.destroy();
      streams.length = 0;
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    (async () => {
      try {
        const deployment = await deploymentService.getDeploymentById(app.db, tenantId, deploymentId);
        const namespace = await deploymentService.getTenantNamespace(app.db, tenantId);
        const k8sTenants = getK8s(app);
        if (!k8sTenants) {
          socket.send(JSON.stringify({ type: 'error', message: 'K8s unavailable' }));
          socket.close(4503, 'K8s unavailable');
          return;
        }

        const kc = getKubeConfig(app);
        let trackedPodNames = new Set<string>();

        function attachLogStream(
          podName: string,
          containerName: string,
          componentName: string,
          lines: number,
        ) {
          const stream = new PassThrough();
          streams.push(stream);
          trackedPodNames.add(podName);

          const log = new k8s.Log(kc);
          log.log(namespace, podName, containerName, stream, {
            follow: true,
            tailLines: lines,
            timestamps: true,
          }).catch(() => { stream.destroy(); });

          let buffer = '';
          stream.on('data', (chunk: Buffer) => {
            if (closed) return;
            buffer += chunk.toString();
            const splitLines = buffer.split('\n');
            buffer = splitLines.pop() ?? '';
            for (const line of splitLines) {
              if (!line) continue;
              const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)/);
              const upper = line.toUpperCase();
              let level = 'info';
              if (upper.includes('ERROR') || upper.includes('FATAL')) level = 'error';
              else if (upper.includes('WARN')) level = 'warning';

              try {
                socket.send(JSON.stringify({
                  type: 'log',
                  component: componentName,
                  timestamp: tsMatch?.[1] ?? new Date().toISOString(),
                  text: tsMatch?.[2] ?? line,
                  level,
                }));
              } catch { cleanup(); }
            }
          });
          stream.on('error', () => { /* handled by cleanup */ });
        }

        // Initial pod discovery + attach
        const initialPods = await fetchPods(k8sTenants, namespace, deployment.name);
        const initialComponents = listDeploymentComponents(initialPods);

        if (initialComponents.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: 'No running pods found' }));
          socket.close(4404, 'No pods');
          return;
        }

        const targets = componentFilter && componentFilter !== '*'
          ? initialComponents.filter((c) => c.name === componentFilter)
          : initialComponents;

        if (targets.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: `Component "${componentFilter}" not found` }));
          socket.close(4404, 'Component not found');
          return;
        }

        socket.send(JSON.stringify({
          type: 'connected',
          components: targets.map((c) => c.name),
        }));

        for (const target of targets) {
          if (closed) break;
          attachLogStream(target.podName, target.containerName, target.name, tailLines);
        }

        // Pod watcher: every 5s, check if pods changed (restart/scale).
        // If new pods appear, attach log streams. If all pods gone, notify tenant.
        const podWatcher = setInterval(async () => {
          if (closed) { clearInterval(podWatcher); return; }
          try {
            const currentPods = await fetchPods(k8sTenants, namespace, deployment.name);
            const currentComponents = listDeploymentComponents(currentPods);

            const applicableComponents = componentFilter && componentFilter !== '*'
              ? currentComponents.filter((c) => c.name === componentFilter)
              : currentComponents;

            for (const comp of applicableComponents) {
              if (!trackedPodNames.has(comp.podName) && comp.status === 'running') {
                // New pod detected — destroy old streams and attach to new pod
                for (const s of streams) s.destroy();
                streams.length = 0;
                trackedPodNames = new Set();

                try {
                  socket.send(JSON.stringify({
                    type: 'log',
                    component: comp.name,
                    text: '--- reconnected to new pod ---',
                    level: 'info',
                    timestamp: new Date().toISOString(),
                  }));
                } catch { cleanup(); return; }

                for (const c of applicableComponents) {
                  if (c.status === 'running') {
                    attachLogStream(c.podName, c.containerName, c.name, 10);
                  }
                }
                break;
              }
            }
          } catch { /* k8s query failed, retry next cycle */ }
        }, 5_000);

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (closed) { clearInterval(heartbeat); return; }
          try { socket.ping(); } catch { cleanup(); clearInterval(heartbeat); }
        }, 30_000);

        socket.on('close', () => {
          clearInterval(heartbeat);
          clearInterval(podWatcher);
        });
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'An internal error occurred';
        try {
          socket.send(JSON.stringify({ type: 'error', message: msg }));
          socket.close(4500, 'Internal error');
        } catch { /* already closed */ }
      }
    })();
  });

  // WebSocket: /api/v1/tenants/:tenantId/deployments/:deploymentId/terminal
  app.get('/tenants/:tenantId/deployments/:deploymentId/terminal', {
    websocket: true,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, (socket, request) => {
    let user: JwtPayload;
    try {
      user = authenticateWs(app, request);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      socket.close(4401, 'Unauthorized');
      return;
    }

    // Terminal access: platform staff + tenant admins (for their own deployments)
    const terminalRoles = ['super_admin', 'admin', 'tenant_admin'];
    if (!terminalRoles.includes(user.role)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Terminal access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }

    const { tenantId, deploymentId } = request.params as ConsoleParams;

    try {
      enforceTenantAccess(user, tenantId);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
      socket.close(4403, 'Forbidden');
      return;
    }

    const query = request.query as ConsoleQuery;
    const componentName = query.component;
    const requestedShell = query.shell ?? '/bin/sh';
    const shell = ALLOWED_SHELLS.has(requestedShell) ? requestedShell : '/bin/sh';
    let closed = false;

    const cleanup = () => { closed = true; };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    (async () => {
      try {
        const deployment = await deploymentService.getDeploymentById(app.db, tenantId, deploymentId);
        const namespace = await deploymentService.getTenantNamespace(app.db, tenantId);
        const k8sTenants = getK8s(app);
        if (!k8sTenants) {
          socket.send(JSON.stringify({ type: 'error', message: 'K8s unavailable' }));
          socket.close(4503, 'K8s unavailable');
          return;
        }

        const pods = await fetchPods(k8sTenants, namespace, deployment.name);
        const components = listDeploymentComponents(pods);

        const target = componentName
          ? components.find((c) => c.name === componentName)
          : components[0];

        if (!target) {
          socket.send(JSON.stringify({ type: 'error', message: 'No running pod found for component' }));
          socket.close(4404, 'No pod');
          return;
        }

        socket.send(JSON.stringify({
          type: 'connected',
          component: target.name,
          pod: target.podName,
          shell,
        }));

        const kc = getKubeConfig(app);
        const exec = new k8s.Exec(kc);

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();

        const wsConn = await exec.exec(
          namespace,
          target.podName,
          target.containerName,
          [shell],
          stdout,
          stderr,
          stdin,
          true, // tty
        );

        stdout.on('data', (chunk: Buffer) => {
          if (closed) return;
          try {
            socket.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
          } catch { cleanup(); }
        });

        stderr.on('data', (chunk: Buffer) => {
          if (closed) return;
          try {
            socket.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
          } catch { cleanup(); }
        });

        socket.on('message', (raw: Buffer | string) => {
          if (closed) return;
          try {
            const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
            if (msg.type === 'stdin' && typeof msg.data === 'string') {
              stdin.write(msg.data);
            } else if (msg.type === 'resize' && typeof msg.cols === 'number') {
              // K8s exec resize is handled via the WebSocket status channel
              // which @kubernetes/client-node manages internally for tty
            }
          } catch {
            // Raw text input as fallback
            stdin.write(typeof raw === 'string' ? raw : raw.toString());
          }
        });

        const onWsClose = () => {
          stdin.destroy();
          stdout.destroy();
          stderr.destroy();
          if (wsConn && typeof (wsConn as { close?: () => void }).close === 'function') {
            (wsConn as { close: () => void }).close();
          }
        };

        socket.on('close', onWsClose);

        stdout.on('end', () => {
          if (!closed) {
            socket.send(JSON.stringify({ type: 'exit', message: 'Shell exited' }));
            socket.close(1000, 'Shell exited');
          }
        });

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (closed) { clearInterval(heartbeat); return; }
          try { socket.ping(); } catch { cleanup(); clearInterval(heartbeat); }
        }, 30_000);

        socket.on('close', () => clearInterval(heartbeat));
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'An internal error occurred';
        try {
          socket.send(JSON.stringify({ type: 'error', message: msg }));
          socket.close(4500, 'Internal error');
        } catch { /* already closed */ }
      }
    })();
  });
}
