import { describe, it, expect } from 'vitest';
import { applyMultihostPhpHardening, MULTIHOST_DISABLED_PHP_FUNCTIONS } from './k8s-deployer.js';

const MH = { configDir: '/etc/apache2/insula/sites.d', sitesRoot: '/var/www/sites', configMapName: 'x' };

describe('multi-host PHP hardening', () => {
  it('sets the platform list when nothing is configured', () => {
    const env: Array<{ name: string; value: string }> = [];
    applyMultihostPhpHardening(env, MH);
    expect(env).toEqual([{ name: 'PHP_DISABLE_FUNCTIONS', value: MULTIHOST_DISABLED_PHP_FUNCTIONS }]);
  });

  /**
   * The regression. The catalog shipped `default: ""` for this key and the
   * deploy dialog materialises every non-undefined default, so EVERY
   * deployment created through the panel arrived carrying an empty value. A
   * presence check read that as an operator override and skipped the
   * hardening — leaving the sandbox exec-escapable on the one path that
   * creates every multi-host deployment.
   */
  it('treats an empty value as absent, not as an override', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: '' }];
    applyMultihostPhpHardening(env, MH);
    expect(env[0].value).toBe(MULTIHOST_DISABLED_PHP_FUNCTIONS);
  });

  it('treats whitespace as absent too', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: '   ' }];
    applyMultihostPhpHardening(env, MH);
    expect(env[0].value).toBe(MULTIHOST_DISABLED_PHP_FUNCTIONS);
  });

  /**
   * The second regression. This key is tenant-editable, so treating any
   * non-empty value as "the operator decided" let a tenant set it to
   * `exec,system` — or to `1` — on their own shared instance and hand
   * themselves back shell_exec, proc_open and the rest.
   */
  it('treats a configured value as an ADDITION, never a replacement', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: 'exec,system' }];
    applyMultihostPhpHardening(env, MH);
    for (const fn of MULTIHOST_DISABLED_PHP_FUNCTIONS.split(',')) {
      expect(env[0].value.split(','), `${fn} was removed from the baseline`).toContain(fn);
    }
  });

  it('lets an operator disable MORE, and keeps it', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: 'curl_exec' }];
    applyMultihostPhpHardening(env, MH);
    expect(env[0].value.split(',')).toContain('curl_exec');
    expect(env[0].value.split(',')).toContain('shell_exec');
  });

  it('cannot be weakened to a single harmless-looking value', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: '1' }];
    applyMultihostPhpHardening(env, MH);
    expect(env[0].value.split(',')).toContain('proc_open');
  });

  it('does not duplicate a function already in the baseline', () => {
    const env = [{ name: 'PHP_DISABLE_FUNCTIONS', value: 'exec' }];
    applyMultihostPhpHardening(env, MH);
    expect(env[0].value.split(',').filter((f) => f === 'exec')).toHaveLength(1);
  });

  it('leaves single-site deployments alone', () => {
    const env: Array<{ name: string; value: string }> = [];
    applyMultihostPhpHardening(env, null);
    expect(env).toEqual([]);
  });

  it('disables every process-spawning primitive, not a subset', () => {
    // open_basedir does not restrain a child process, so ONE reachable
    // spawner is the whole sandbox.
    for (const fn of ['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'pcntl_exec']) {
      expect(MULTIHOST_DISABLED_PHP_FUNCTIONS.split(',')).toContain(fn);
    }
  });
});
