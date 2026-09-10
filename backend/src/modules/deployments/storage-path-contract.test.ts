import { describe, it, expect } from 'vitest';
import { createDeploymentSchema, updateDeploymentSchema } from '@insula/api-contracts';

/**
 * `storage_path` is the folder on the tenant PVC a deployment is mounted from.
 * It used to be `z.string().max(500)` — no shape at all — while the UI forced
 * every custom folder under `<type>/<code>/<name>`. Now the UI can offer ANY
 * folder, so this field is the only thing standing between a tenant and a path
 * that escapes their PVC. It shares `folderProblem` with extra mounts so both
 * surfaces enforce one rule.
 *
 * Lives under backend/src because that is where vitest actually looks:
 * `packages/api-contracts/**\/*.test.ts` is picked up by no runner at all
 * (backend runs `--dir src`, and ci-api-contracts.yml only builds and checks
 * exports), so a test placed next to the schema would never execute.
 */

const BASE_CREATE = {
  catalog_entry_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  name: 'my-app',
};

const pathIssue = (v: string) => {
  const r = createDeploymentSchema.safeParse({ ...BASE_CREATE, storage_path: v });
  return r.success ? null : r.error.issues.find((i) => i.path[0] === 'storage_path')?.message ?? 'rejected';
};

describe('createDeploymentSchema.storage_path', () => {
  it('accepts the shape every existing deployment already uses', () => {
    // All 45 rows in the field are `<type>/<code>/<name>`. A new constraint
    // that rejected any of them would break redeploys of live apps.
    expect(pathIssue('runtime/apache-php/mh-born')).toBeNull();
    expect(pathIssue('static/nginx/mh-sn')).toBeNull();
  });

  it('accepts a folder anywhere on the PVC, not just under <type>/<code>', () => {
    // The entire point of the change.
    expect(pathIssue('business.na')).toBeNull();
    expect(pathIssue('media/library')).toBeNull();
    expect(pathIssue('www.example.com')).toBeNull();
    expect(pathIssue('Website')).toBeNull();
  });

  it('refuses to escape the tenant PVC', () => {
    expect(pathIssue('../../etc')).not.toBeNull();
    expect(pathIssue('media/../../root')).not.toBeNull();
    expect(pathIssue('..')).not.toBeNull();
  });

  it('refuses absolute paths and dotfiles', () => {
    expect(pathIssue('/etc/passwd')).not.toBeNull();
    expect(pathIssue('.ssh')).not.toBeNull();
    expect(pathIssue('media/.git')).not.toBeNull();
  });

  it('caps depth', () => {
    expect(pathIssue('a/b/c/d')).toBeNull();
    expect(pathIssue('a/b/c/d/e')).not.toBeNull();
  });

  it('stays optional', () => {
    expect(createDeploymentSchema.safeParse(BASE_CREATE).success).toBe(true);
  });
});

describe('updateDeploymentSchema.storage_path', () => {
  it('accepts a re-point to any valid folder', () => {
    const r = updateDeploymentSchema.safeParse({ storage_path: 'media/shared/site-a' });
    expect(r.success).toBe(true);
  });

  it('applies the same escape guard as create', () => {
    // A weaker rule on the UPDATE path would make the create guard pointless —
    // an attacker picks whichever endpoint validates less.
    expect(updateDeploymentSchema.safeParse({ storage_path: '../../etc' }).success).toBe(false);
    expect(updateDeploymentSchema.safeParse({ storage_path: '/etc' }).success).toBe(false);
  });

  it('leaves the path untouched when the field is absent', () => {
    const r = updateDeploymentSchema.safeParse({ name: 'renamed' });
    expect(r.success).toBe(true);
    expect(r.success && 'storage_path' in r.data).toBe(false);
  });
});
