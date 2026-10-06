import { describe, expect, it } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { dispatcherKey, installK8sConnectionPool, pooledDispatcherCount } from './k8s-connection-pool.js';

const CA_1 = Buffer.from('ca-one').toString('base64');

/**
 * A KubeConfig pointing at `server`, authenticating with a bearer token.
 * Always with a CA: in-cluster configs carry the service-account CA, and that
 * is the case that got a fresh dispatcher per request. With no TLS options at
 * all the library hands the request to the global (already pooled) dispatcher.
 */
function kubeConfig(server: string, token: string, caData: string = CA_1): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'c', server, caData, skipTLSVerify: false }],
    users: [{ name: 'u', token }],
    contexts: [{ name: 'ctx', cluster: 'c', user: 'u' }],
    currentContext: 'ctx',
  });
  return kc;
}

/** Run the library's own auth step and capture what it attaches. */
async function authenticate(kc: k8s.KubeConfig): Promise<{ dispatcher: unknown; headers: Record<string, string> }> {
  let dispatcher: unknown;
  const headers: Record<string, string> = {};
  const context = {
    setHeaderParam: (k: string, v: string) => { headers[k] = v; },
    setDispatcher: (d: unknown) => { dispatcher = d; },
    setAgent: () => { throw new Error('2.x must use a dispatcher, not an agent'); },
  };
  await kc.applySecurityAuthentication(context as never);
  return { dispatcher, headers };
}

describe('k8s connection pool', () => {
  it('the installed client still builds its dispatcher where the pool hooks in', () => {
    // If a library upgrade renames this, pooling silently turns off — fail here instead.
    expect(typeof (k8s.KubeConfig.prototype as unknown as { createDispatcher?: unknown }).createDispatcher)
      .toBe('function');
    expect(installK8sConnectionPool()).toBe(true);
  });

  it('two KubeConfigs for the same endpoint share one dispatcher', async () => {
    installK8sConnectionPool();
    const a = await authenticate(kubeConfig('https://pool-test-a.invalid:6443', 'token-a'));
    const b = await authenticate(kubeConfig('https://pool-test-a.invalid:6443', 'token-b'));
    expect(a.dispatcher).toBeDefined();
    expect(b.dispatcher).toBe(a.dispatcher);
    // The credential stays per request — sharing the socket shares no identity.
    expect(a.headers.Authorization).toBe('Bearer token-a');
    expect(b.headers.Authorization).toBe('Bearer token-b');
  });

  it('a different server or trust anchor gets its own dispatcher', async () => {
    installK8sConnectionPool();
    const base = await authenticate(kubeConfig('https://pool-test-b.invalid:6443', 't'));
    const otherServer = await authenticate(kubeConfig('https://pool-test-c.invalid:6443', 't'));
    const otherCa = await authenticate(kubeConfig(
      'https://pool-test-b.invalid:6443', 't', Buffer.from('ca-two').toString('base64'),
    ));
    expect(otherServer.dispatcher).not.toBe(base.dispatcher);
    expect(otherCa.dispatcher).not.toBe(base.dispatcher);
  });

  it('repeated requests on one KubeConfig do not grow the pool', async () => {
    installK8sConnectionPool();
    const kc = kubeConfig('https://pool-test-d.invalid:6443', 't');
    await authenticate(kc);
    const size = pooledDispatcherCount();
    for (let i = 0; i < 5; i++) await authenticate(kc);
    expect(pooledDispatcherCount()).toBe(size);
  });

  it('keys on transport identity only', () => {
    const cluster = { server: 'https://x:6443' };
    expect(dispatcherKey(cluster, { ca: Buffer.from('a') })).toBe(dispatcherKey(cluster, { ca: Buffer.from('a') }));
    expect(dispatcherKey(cluster, { ca: Buffer.from('a') })).not.toBe(dispatcherKey(cluster, { ca: Buffer.from('b') }));
    expect(dispatcherKey(cluster, { cert: 'c1' })).not.toBe(dispatcherKey(cluster, { cert: 'c2' }));
    expect(dispatcherKey(cluster, {})).not.toBe(dispatcherKey({ ...cluster, proxyUrl: 'http://p:3128' }, {}));
  });
});
