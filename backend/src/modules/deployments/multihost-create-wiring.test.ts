import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A source-level assertion, deliberately.
 *
 * `multihostMountsFor` is unit-tested and correct, and `createDeployment`
 * shipped anyway with `multihost: null` hard-coded at the deploy call and the
 * flag missing from the insert — so a deployment created with multi-host on
 * came up with the flag off and no mounts. Nothing caught it:
 *
 *  - TypeScript cannot: `null` satisfies `MultihostMounts | null`, and omitting
 *    a defaulted column from an insert is legal.
 *  - The unit tests cannot: they exercise the helper, and a tested helper says
 *    nothing about whether the path that matters calls it.
 *  - There is no cheap seam to call `createDeployment` — it needs a database.
 *
 * So this checks the wiring the only way that is cheap and stable: that the
 * create path references the resolver at all, and no longer hard-codes null.
 * If `createDeployment` is refactored so this no longer applies, delete it —
 * but replace it with something that covers the same gap.
 */
const servicePath = join(dirname(fileURLToPath(import.meta.url)), 'service.ts');
const source = readFileSync(servicePath, 'utf-8');

describe('createDeployment wires multi-host through', () => {
  it('persists the flag on the new row', () => {
    expect(source).toContain('multihostEnabled: wantsMultihost');
  });

  it('resolves the deployer mounts instead of hard-coding null', () => {
    expect(source).toContain('multihost: multihostMountsFor({ name: input.name');
    // The literal that shipped. Its absence is the actual assertion.
    expect(source).not.toContain('multihost: null');
  });

  it('refuses the flag for an entry with no capability', () => {
    expect(source).toContain("'MULTIHOST_NOT_SUPPORTED'");
  });
});
