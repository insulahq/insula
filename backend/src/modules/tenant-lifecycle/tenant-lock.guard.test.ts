import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every start of a storage operation, and every delete of a tenant, runs
 * under the tenant's lock (tenant-lock.ts). The lock only excludes what takes
 * it, so one starter added without it reopens the gap for all of them — this
 * reads the source to see that none is.
 *
 * The rule it checks: a function that checks-then-claims a tenant — it calls
 * `mustBeIdle`, or is the delete's body — is not exported, and is called from
 * nowhere but a `withTenantLock(…, () => fn(…))`.
 */

const MODULES = join(import.meta.dirname, '..');

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readFileSync(join(MODULES, rel), 'utf8'), ts.ScriptTarget.Latest, true);
}

interface Fn { readonly name: string; readonly exported: boolean; readonly node: ts.FunctionDeclaration }

function functions(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const exported = (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      out.push({ name: node.name.text, exported, node });
    }
  });
  return out;
}

function calls(node: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === callee) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

/** True when `call` sits inside the callback handed to a `withTenantLock(…)`. */
function underTenantLock(call: ts.Node): boolean {
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'withTenantLock') return true;
    if (ts.isFunctionDeclaration(n)) return false;
  }
  return false;
}

function assertLockedOnly(sf: ts.SourceFile, fn: Fn): void {
  expect(fn.exported, `${fn.name} checks and claims a tenant: export a wrapper that takes the tenant's lock, not this`).toBe(false);
  const sites = calls(sf, fn.name);
  expect(sites.length, `${fn.name} is never called`).toBeGreaterThan(0);
  for (const site of sites) {
    expect(underTenantLock(site), `${fn.name} is called outside withTenantLock (line ${sf.getLineAndCharacterOfPosition(site.getStart()).line + 1})`).toBe(true);
  }
}

describe('everything that claims or deletes a tenant holds the tenant\'s lock', () => {
  const service = parse('storage-lifecycle/service.ts');
  const starters = functions(service).filter((f) => f.name !== 'mustBeIdle' && calls(f.node, 'mustBeIdle').length > 0);

  it('finds the storage operations that check a tenant is idle before claiming it', () => {
    expect(starters.map((f) => f.name).sort()).toEqual([
      'resumeTenantLocked',
      'startArchive',
      'startFsck',
      'startResize',
      'startRestoreArchived',
      'startRestoreFromRetainedVolume',
      'startRestoreFromVolumeSnapshot',
      'suspendTenantLocked',
    ]);
  });

  it.each(starters.map((f) => [f.name, f] as const))('%s is private and only ever called under the lock', (_name, fn) => {
    assertLockedOnly(service, fn);
  });

  it('the tenant delete\'s body is private and only ever called under the lock', () => {
    const tenants = parse('tenants/service.ts');
    const body = functions(tenants).find((f) => f.name === 'deleteTenantLocked');
    expect(body, 'tenants/service.ts no longer has deleteTenantLocked — point this guard at the delete\'s body').toBeDefined();
    assertLockedOnly(tenants, body!);
    // …and it is the only place the cascade that drops a tenant is called from there.
    const cascade = calls(tenants, 'applyDeleted');
    expect(cascade.length).toBeGreaterThan(0);
    for (const site of cascade) {
      let inBody = false;
      for (let n: ts.Node | undefined = site.parent; n; n = n.parent) if (n === body!.node) inBody = true;
      expect(inBody, 'applyDeleted is called outside deleteTenantLocked').toBe(true);
    }
  });

  it('nothing but the tenant delete calls the delete cascade', () => {
    // Bulk delete and the automatic sweep go through deleteTenant; a direct
    // call would skip the lock (and the snapshot purge).
    for (const rel of ['tenants/bulk.ts', 'tenant-lifecycle/automation/real.ts', 'tenant-lifecycle/automation/sweep.ts', 'storage-lifecycle/scheduler.ts']) {
      expect(calls(parse(rel), 'applyDeleted'), `${rel} calls applyDeleted directly`).toEqual([]);
    }
  });

  it('a tenant move claims its tenant under the lock', () => {
    const move = parse('tenant-migration/stop-move-start.ts');
    const begin = functions(move).find((f) => f.name === 'beginTenantMove');
    expect(begin).toBeDefined();
    const locked = calls(begin!.node, 'withTenantLock');
    expect(locked).toHaveLength(1);
    // The claim — the UPDATE that takes the tenant — is inside it.
    expect(locked[0].getText()).toContain('storageLifecycleState: \'quiescing\'');
  });
});
