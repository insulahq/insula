import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();
vi.mock('../../shared/k8s-exec.js', () => ({
  execInPod: (...args: unknown[]) => execMock(...args),
}));

const { reconcileDeploymentSites, CHECKSUM_KEY, vhostConfigMapName, capabilityOf, ingressContainerName } =
  await import('./reconciler.js');
const { siteFilename } = await import('./renderer.js');
import type { MultihostCapability, SiteRoute } from './renderer.js';

const CAP: MultihostCapability = {
  server: 'apache',
  web_root: '/var/www/html',
  sites_root: '/var/www/sites',
  config_dir: '/etc/apache2/insula/sites.d',
  common_include: '/etc/apache2/insula/site-common.conf',
  listen: 8080,
  validate: ['apache2ctl', 'configtest'],
  reload: ['apache2ctl', 'graceful'],
};

const site = (id: string, host: string, folder: string): SiteRoute =>
  ({ id, hostname: host, path: '/', wwwRedirect: 'none', siteFolder: folder });

/** Minimal CoreV1Api double that remembers the ConfigMap it was given. */
function fakeCore(initial?: Record<string, string>) {
  const state: { data?: Record<string, string>; rv: string } = { data: initial, rv: '1' };
  const calls = { create: 0, replace: 0, patch: 0 };
  return {
    calls,
    state,
    core: {
      readNamespacedConfigMap: async () => {
        if (!state.data) throw new Error('404');
        return { data: state.data, metadata: { resourceVersion: state.rv } };
      },
      createNamespacedConfigMap: async ({ body }: { body: { data: Record<string, string> } }) => {
        calls.create += 1; state.data = body.data; return {};
      },
      replaceNamespacedConfigMap: async ({ body }: { body: { data: Record<string, string> } }) => {
        calls.replace += 1; state.data = body.data; return {};
      },
      patchNamespacedConfigMap: async () => { calls.patch += 1; return {}; },
      listNamespacedPod: async () => ({
        items: [{
          metadata: { name: 'pod-1' },
          status: { phase: 'Running' },
          spec: { containers: [{ name: 'apache-php' }] },
        }],
      }),
    } as never,
  };
}

const baseInput = (routes: SiteRoute[]) => ({
  namespace: 'tenant-x',
  deploymentId: 'dep-1',
  deploymentName: 'sites',
  capability: CAP,
  containerName: 'apache-php',
  routes,
  sleep: async () => {},
  projectionTimeoutMs: 30,
});

/** exec double: `cat checksum` returns whatever the ConfigMap currently holds. */
function wireExec(state: { data?: Record<string, string> }, over: { validateExit?: number; reloadExit?: number; staleChecksum?: boolean } = {}) {
  execMock.mockImplementation(async (_kc: unknown, _ns: unknown, _pod: unknown, _c: unknown, cmd: string[]) => {
    if (cmd[0] === 'cat' || cmd[1] === '-T') {
      if (over.staleChecksum) return { stdout: '# insula-checksum stale', stderr: '', exitCode: 0 };
      return { stdout: state.data?.[CHECKSUM_KEY] ?? '', stderr: '', exitCode: 0 };
    }
    if (cmd[1] === 'configtest') return { stdout: '', stderr: 'Syntax error on line 1', exitCode: over.validateExit ?? 0 };
    if (cmd[1] === 'graceful') return { stdout: '', stderr: '', exitCode: over.reloadExit ?? 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

beforeEach(() => {
  // Block body on purpose. `() => execMock.mockReset()` returns the mock, and
  // vitest calls a function returned from beforeEach as the test's teardown —
  // which invoked the mock implementation with zero arguments after every test.
  execMock.mockReset();
});

describe('reconcileDeploymentSites', () => {
  it('writes the sites and reloads once the projection carries the new checksum', async () => {
    const f = fakeCore();
    wireExec(f.state);
    const r = await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'folder-a')]));
    expect(r.changed).toBe(true);
    expect(r.siteCount).toBe(1);
    expect(r.reloaded).toBe(1);
    expect(r.failures).toEqual([]);
    expect(f.state.data?.[siteFilename('a')]).toContain('ServerName one.test');
    const cmds = execMock.mock.calls.map((c) => (c[4] as string[]).join(' '));
    expect(cmds).toContain('apache2ctl configtest');
    expect(cmds).toContain('apache2ctl graceful');
  });

  it('REPLACES the ConfigMap so a deleted route stops being served', async () => {
    // A merge patch would leave route b's file in place and the site would keep
    // answering — the deletion would look like it worked.
    const f = fakeCore();
    wireExec(f.state);
    await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa'), site('b', 'two.test', 'fb')]));
    expect(Object.keys(f.state.data ?? {})).toContain(siteFilename('b'));

    await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')]));
    expect(Object.keys(f.state.data ?? {})).not.toContain(siteFilename('b'));
    expect(f.calls.patch).toBe(0);
  });

  it('does not write or reload when nothing changed', async () => {
    const f = fakeCore();
    wireExec(f.state);
    const routes = [site('a', 'one.test', 'fa')];
    await reconcileDeploymentSites({ core: f.core }, baseInput(routes));
    execMock.mockClear();
    const writesBefore = f.calls.create + f.calls.replace;

    const second = await reconcileDeploymentSites({ core: f.core }, baseInput(routes));
    expect(second.changed).toBe(false);
    expect(f.calls.create + f.calls.replace).toBe(writesBefore);
    // No reload — an unconditional reload on every route settings change would
    // churn every tenant's web server for nothing.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does NOT reload when the config check fails, and says why', async () => {
    const f = fakeCore();
    wireExec(f.state, { validateExit: 1 });
    const r = await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')]));
    expect(r.reloaded).toBe(0);
    expect(r.failures[0].reason).toContain('config check failed');
    const cmds = execMock.mock.calls.map((c) => (c[4] as string[]).join(' '));
    expect(cmds).not.toContain('apache2ctl graceful');
  });

  it('does NOT reload when the projection never lands', async () => {
    // Reloading here would pick up the PREVIOUS generation and report success.
    const f = fakeCore();
    wireExec(f.state, { staleChecksum: true });
    const r = await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')]));
    expect(r.reloaded).toBe(0);
    expect(r.failures[0].reason).toContain('did not reach the pod');
    const cmds = execMock.mock.calls.map((c) => (c[4] as string[]).join(' '));
    expect(cmds).not.toContain('apache2ctl configtest');
  });

  it('still writes the ConfigMap when the deployment is scaled to zero', async () => {
    const f = fakeCore();
    wireExec(f.state);
    (f.core as { listNamespacedPod: unknown }).listNamespacedPod = async () => ({ items: [] });
    const r = await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')]));
    expect(r.changed).toBe(true);
    expect(r.reloaded).toBe(0);
    expect(r.failures).toEqual([]);
    expect(f.state.data?.[siteFilename('a')]).toBeDefined();
  });

  it('reports folderCheck=unavailable when the probe cannot run, not an empty list', () => {
    // A distroless image (static-nginx) has no `sh`, so the exec fails. An
    // empty missingFolders would read as "every folder is present" — a
    // confident answer from a check that never ran.
    const f = fakeCore();
    execMock.mockImplementation(async (..._a: unknown[]) => {
      const cmd = _a[4] as string[];
      if (cmd[0] === 'cat') return { stdout: f.state.data?.[CHECKSUM_KEY] ?? '', stderr: '', exitCode: 0 };
      if (cmd[0] === 'sh') throw new Error('exec: "sh": executable file not found in $PATH');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    return reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')])).then((r) => {
      expect(r.reloaded).toBe(1);
      expect(r.missingFolders).toEqual([]);
      expect(r.folderCheck).toBe('unavailable');
    });
  });

  it('reports folderCheck=ok when the probe ran and found everything present', () => {
    const f = fakeCore();
    wireExec(f.state);
    return reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')])).then((r) => {
      expect(r.folderCheck).toBe('ok');
      expect(r.missingFolders).toEqual([]);
    });
  });

  it('probes projection with the nginx binary, not `cat`, on the nginx flavour', async () => {
    // A distroless image (static-nginx) has no `cat`. The previous probe failed
    // outright there, so the reload never fired and every site silently stayed
    // on the catch-all while the ConfigMap looked perfectly applied.
    const f = fakeCore();
    wireExec(f.state);
    const NGINX_CAP = {
      ...CAP, server: 'nginx',
      config_dir: '/etc/nginx/insula/sites.d',
      common_include: '/etc/nginx/insula/site-common.conf',
      validate: ['/usr/sbin/nginx', '-t'], reload: ['/usr/sbin/nginx', '-s', 'reload'],
    };
    const r = await reconcileDeploymentSites({ core: f.core },
      // containerName must match the fake pod's container, or runningPods
      // filters it out and the test would pass for the wrong reason.
      { ...baseInput([site('a', 'one.test', 'fa')]), capability: NGINX_CAP });
    expect(r.reloaded).toBe(1);
    const cmds = execMock.mock.calls.map((c) => (c[4] as string[]).join(' '));
    expect(cmds).toContain('/usr/sbin/nginx -T');
    expect(cmds.some((c) => c.startsWith('cat '))).toBe(false);
    expect(cmds).toContain('/usr/sbin/nginx -s reload');
  });

  it('keeps reading the file on the apache flavour, where cat exists', async () => {
    const f = fakeCore();
    wireExec(f.state);
    await reconcileDeploymentSites({ core: f.core }, baseInput([site('a', 'one.test', 'fa')]));
    const cmds = execMock.mock.calls.map((c) => (c[4] as string[]).join(' '));
    expect(cmds).toContain(`cat /etc/apache2/insula/sites.d/${CHECKSUM_KEY}`);
  });

  it('puts the checksum in an INCLUDED .conf so nginx -T can see it', () => {
    // If it were `checksum.txt` the include glob would skip it and `nginx -T`
    // could never show it — which is exactly why the distroless probe failed.
    expect(CHECKSUM_KEY.endsWith('.conf')).toBe(true);
  });

  it('with deferActivation, writes the ConfigMap but does NOT wait or reload', async () => {
    // The request path sets this. Doing the wait + reload inline made a route
    // PATCH run ~52s and return a gateway 502 for a change that had actually
    // applied — an error for a save that worked.
    const f = fakeCore();
    wireExec(f.state);
    const r = await reconcileDeploymentSites({ core: f.core },
      { ...baseInput([site('a', 'one.test', 'fa')]), deferActivation: true });

    // The durable source IS written before returning — that is what makes
    // deferring safe: a pod restarting later comes up correct regardless.
    expect(r.changed).toBe(true);
    expect(f.state.data?.[siteFilename('a')]).toContain('ServerName one.test');
    // ...but nothing was awaited on the pod.
    expect(r.reloaded).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it('names the ConfigMap after the deployment', () => {
    expect(vhostConfigMapName('sites')).toBe('sites-vhosts');
  });
});

describe('capabilityOf', () => {
  it('accepts a complete block and rejects a partial one', () => {
    expect(capabilityOf({ multihost: CAP })?.server).toBe('apache');
    expect(capabilityOf({ multihost: { ...CAP, listen: undefined } })).toBeNull();
    expect(capabilityOf({ multihost: { ...CAP, validate: [] } })).toBeNull();
    expect(capabilityOf({ multihost: null })).toBeNull();
    expect(capabilityOf(null)).toBeNull();
  });
});

describe('ingressContainerName', () => {
  it('picks the component that owns the ingress port', () => {
    const entry = { components: [
      { name: 'sidecar', ports: [{ ingress: false }] },
      { name: 'apache-php', ports: [{ ingress: true }] },
    ] };
    expect(ingressContainerName(entry, 'dep')).toBe('apache-php');
  });
  it('falls back to the deployment name when the entry declares no components', () => {
    expect(ingressContainerName({ components: null }, 'dep')).toBe('dep');
  });
});
