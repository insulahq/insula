import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/k8s-exec.js', () => ({ execInPod: vi.fn() }));

const { ensureSiteMounts } = await import('./reconciler.js');
import type { MultihostCapability } from './renderer.js';

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

/** The clause buildVolumeMountSpec emits for the deployment's OWN storage. */
const OWN_STORAGE_CLAUSE =
  'mkdir -p /data/runtime/apache-php-office/site && chmod 777 /data/runtime/apache-php-office/site';

function fakeApps(initialCommand: string, mounts: Array<Record<string, unknown>> = []) {
  const dep = {
    metadata: { name: 'site', namespace: 'tenant-x', resourceVersion: '7' },
    spec: {
      template: {
        spec: {
          containers: [{ name: 'apache-php-office', volumeMounts: mounts }],
          initContainers: [{
            name: 'init-dirs',
            image: 'busybox:1.36',
            command: ['sh', '-c', initialCommand],
            volumeMounts: [{ name: 'tenant-storage', mountPath: '/data' }],
          }],
          volumes: [{ name: 'tenant-storage', persistentVolumeClaim: { claimName: 'tenant-x-storage' } }],
        },
      },
    },
  };
  const apps = {
    readNamespacedDeployment: vi.fn().mockResolvedValue(dep),
    replaceNamespacedDeployment: vi.fn().mockImplementation(async (args: { body: unknown }) => {
      return args.body;
    }),
  };
  return { apps: { apps } as never, dep };
}

const input = {
  capability: CAP,
  namespace: 'tenant-x',
  deploymentName: 'site',
  containerName: 'apache-php-office',
} as never;

const rendered = (folders: string[]) =>
  ({ sites: folders.map((f) => ({ appRootPath: `/var/www/sites/${f}` })) }) as never;

const commandAfter = (apps: { apps: { replaceNamespacedDeployment: ReturnType<typeof vi.fn> } }) => {
  const body = apps.apps.replaceNamespacedDeployment.mock.calls.at(-1)?.[0].body;
  return body.spec.template.spec.initContainers[0].command[2] as string;
};

describe('ensureSiteMounts — site directory creation', () => {
  // Adding a site to a LIVE pod patches volumeMounts. Without the matching
  // mkdir, kubelet creates the subPath as root:root 0755 and the site arrives
  // unwritable — which is what happened on DEV when a second Moodle was added
  // beside the first: `mkdir /var/www/sites/moodle-b/www` → Permission denied.
  it('creates the folder for a site added to a running pod', async () => {
    const f = fakeApps(OWN_STORAGE_CLAUSE);
    const changed = await ensureSiteMounts(f.apps, input, rendered(['moodle-b']));

    expect(changed).toBe(true);
    const cmd = commandAfter(f.apps as never);
    expect(cmd).toContain('mkdir -p /data/moodle-b && chmod 777 /data/moodle-b');
  });

  it("keeps the deployment's own storage clause, which looks identical", async () => {
    // The own-storage clause has exactly the shape of a site clause. A rewrite
    // that matched by shape would drop it and stop re-creating the
    // deployment's data directory on later restarts.
    const f = fakeApps(OWN_STORAGE_CLAUSE);
    await ensureSiteMounts(f.apps, input, rendered(['moodle-b']));

    expect(commandAfter(f.apps as never)).toContain(OWN_STORAGE_CLAUSE);
  });

  it('drops the clause for a site that stopped being served', async () => {
    const f = fakeApps(
      `${OWN_STORAGE_CLAUSE} && mkdir -p /data/moodle-b && chmod 777 /data/moodle-b`,
      [
        { name: 'tenant-storage', mountPath: '/var/www/sites/moodle-b', subPath: 'moodle-b' },
        { name: 'multihost-sessions', mountPath: '/var/lib/php-sessions/moodle-b', subPath: 'moodle-b' },
      ],
    );
    await ensureSiteMounts(f.apps, input, rendered(['moodle-c']));

    const cmd = commandAfter(f.apps as never);
    expect(cmd).toContain('/data/moodle-c');
    expect(cmd).not.toContain('/data/moodle-b ');
    expect(cmd).toContain(OWN_STORAGE_CLAUSE);
  });

  it('does not accumulate duplicate clauses across route changes', async () => {
    const f = fakeApps(
      `${OWN_STORAGE_CLAUSE} && mkdir -p /data/moodle-b && chmod 777 /data/moodle-b`,
      [
        { name: 'tenant-storage', mountPath: '/var/www/sites/moodle-b', subPath: 'moodle-b' },
      ],
    );
    await ensureSiteMounts(f.apps, input, rendered(['moodle-b', 'moodle-c']));

    const cmd = commandAfter(f.apps as never);
    const occurrences = cmd.split('mkdir -p /data/moodle-b &&').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ensureSiteMounts — self-healing an existing pod', () => {
  // Every multi-host pod created before the site-directory clauses existed has
  // correct mounts and an init container that cannot create the folder. The
  // mount comparison alone says "nothing to do", so those pods would stay
  // broken until someone happened to add or remove a site. Observed on DEV:
  // touching a route returned HTTP 200 and rewrote nothing.
  it('rewrites a pod whose mounts are right but whose init command is old', async () => {
    const f = fakeApps(OWN_STORAGE_CLAUSE, [
      { name: 'tenant-storage', mountPath: '/var/www/sites/moodle-b', subPath: 'moodle-b' },
      { name: 'multihost-sessions', mountPath: '/var/lib/php-sessions/moodle-b', subPath: 'moodle-b' },
    ]);

    const changed = await ensureSiteMounts(f.apps, input, rendered(['moodle-b']));

    expect(changed).toBe(true);
    expect(commandAfter(f.apps as never)).toContain('mkdir -p /data/moodle-b && chmod 777 /data/moodle-b');
  });

  it('still does nothing when the mounts AND the init command are already right', async () => {
    const f = fakeApps(
      `${OWN_STORAGE_CLAUSE} && mkdir -p /data/moodle-b && chmod 777 /data/moodle-b`
      + ' && mkdir -p /var/lib/php-sessions/moodle-b && chmod 777 /var/lib/php-sessions/moodle-b',
      [
        { name: 'tenant-storage', mountPath: '/var/www/sites/moodle-b', subPath: 'moodle-b' },
        { name: 'multihost-sessions', mountPath: '/var/lib/php-sessions/moodle-b', subPath: 'moodle-b' },
      ],
    );

    const changed = await ensureSiteMounts(f.apps, input, rendered(['moodle-b']));

    expect(changed).toBe(false);
    expect(f.apps.apps.replaceNamespacedDeployment).not.toHaveBeenCalled();
  });
});
