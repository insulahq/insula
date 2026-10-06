import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_OAUTH2_PROXY_IMAGE,
  buildPanelProxyArgs,
  buildPanelProxyDeployment,
  buildPanelProxySecret,
  buildPanelProxyService,
  fatalPodProblem,
  panelProxyConfigHash,
  type PanelProxyConfig,
} from './panel-proxy.js';

const cfg: PanelProxyConfig = {
  panel: 'tenant',
  host: 'tenant.example.test',
  provider: { issuerUrl: 'https://id.example.test', clientId: 'panel-client', clientSecret: 's3cret' },
  cookieSecret: 'c'.repeat(32),
};

describe('panel oauth2-proxy manifests', () => {
  it('pins the callback and cookie to the panel host — one proxy per panel', () => {
    const args = buildPanelProxyArgs('tenant', 'tenant.example.test');
    expect(args).toContain('--redirect-url=https://tenant.example.test/oauth2/callback');
    expect(args).toContain('--whitelist-domain=tenant.example.test');
    expect(args).toContain('--cookie-name=_insula_proxy_tenant');
    expect(args.some((a) => a.startsWith('--cookie-domain'))).toBe(false);
    // The API authenticates itself; gating it would break the panel's sign-in.
    expect(args).toContain('--skip-auth-route=^/api/');
    // Not the oauth2-proxy default `force` — that is a consent screen per login.
    expect(args).toContain('--approval-prompt=auto');
  });

  it('keeps every credential out of the pod spec', () => {
    const dep = buildPanelProxyDeployment(cfg);
    const spec = JSON.stringify(dep.spec);
    expect(spec).not.toContain('s3cret');
    expect(spec).not.toContain('c'.repeat(32));
    expect(dep.spec!.template.spec!.containers[0].envFrom).toEqual([{ secretRef: { name: 'oauth2-proxy-tenant' } }]);
    expect(buildPanelProxySecret(cfg).stringData).toEqual({
      OAUTH2_PROXY_OIDC_ISSUER_URL: 'https://id.example.test',
      OAUTH2_PROXY_CLIENT_ID: 'panel-client',
      OAUTH2_PROXY_CLIENT_SECRET: 's3cret',
      OAUTH2_PROXY_COOKIE_SECRET: 'c'.repeat(32),
    });
  });

  it('selects only its own panel, so the two proxies never share a Service', () => {
    expect(buildPanelProxyService('tenant').spec!.selector).toEqual({ app: 'oauth2-proxy-panel', 'insula.host/panel': 'tenant' });
    expect(buildPanelProxyService('admin').spec!.selector).toEqual({ app: 'oauth2-proxy-panel', 'insula.host/panel': 'admin' });
    // Must not be `app: oauth2-proxy`: the Flux-managed proxy's Service selects that.
    expect(buildPanelProxyDeployment(cfg).spec!.template.metadata!.labels!.app).toBe('oauth2-proxy-panel');
  });

  it('runs unprivileged and without an API token', () => {
    const pod = buildPanelProxyDeployment(cfg).spec!.template.spec!;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext?.runAsNonRoot).toBe(true);
    const c = pod.containers[0].securityContext!;
    expect(c.allowPrivilegeEscalation).toBe(false);
    expect(c.readOnlyRootFilesystem).toBe(true);
    expect(c.capabilities?.drop).toEqual(['ALL']);
  });

  it('rolls the pods when any credential or the host changes', () => {
    const base = panelProxyConfigHash(cfg);
    expect(panelProxyConfigHash({ ...cfg })).toBe(base);
    expect(panelProxyConfigHash({ ...cfg, cookieSecret: 'd'.repeat(32) })).not.toBe(base);
    expect(panelProxyConfigHash({ ...cfg, host: 'my.example.test' })).not.toBe(base);
    expect(panelProxyConfigHash({ ...cfg, provider: { ...cfg.provider, clientSecret: 'other' } })).not.toBe(base);
    expect(buildPanelProxyDeployment(cfg).spec!.template.metadata!.annotations!['insula.host/config-hash']).toBe(base);
  });

  it('uses the same oauth2-proxy release as the base manifest', () => {
    const manifest = readFileSync(fileURLToPath(new URL('../../../../k8s/base/oauth2-proxy/deployment.yaml', import.meta.url)), 'utf8');
    const image = /image:\s*(quay\.io\/oauth2-proxy\/oauth2-proxy:\S+)/.exec(manifest)?.[1];
    expect(image).toBe(DEFAULT_OAUTH2_PROXY_IMAGE);
  });
});

describe('fatalPodProblem', () => {
  const pod = (status: k8s.V1ContainerStatus): k8s.V1Pod => ({ metadata: { name: 'p1' }, status: { containerStatuses: [status] } });
  const base = { name: 'oauth2-proxy', image: 'x', imageID: '', ready: false, restartCount: 0 };

  it('is null while the pod is merely starting', () => {
    expect(fatalPodProblem([pod({ ...base, state: { waiting: { reason: 'ContainerCreating' } } })])).toBeNull();
    expect(fatalPodProblem([])).toBeNull();
  });

  it('reports a crash (e.g. failed OIDC discovery) without waiting out the backoff', () => {
    expect(fatalPodProblem([pod({ ...base, restartCount: 1, lastState: { terminated: { reason: 'Error', exitCode: 1 } } })]))
      .toEqual({ pod: 'p1', reason: 'Error' });
    expect(fatalPodProblem([pod({ ...base, restartCount: 2, state: { waiting: { reason: 'CrashLoopBackOff' } } })]))
      .toEqual({ pod: 'p1', reason: 'CrashLoopBackOff' });
  });

  it('reports an image that cannot be pulled', () => {
    expect(fatalPodProblem([pod({ ...base, state: { waiting: { reason: 'ImagePullBackOff' } } })]))
      .toEqual({ pod: 'p1', reason: 'ImagePullBackOff' });
  });
});
