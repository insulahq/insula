/**
 * The release manifest lists every host-migration script and migration file of
 * the repo (release.yml). A name the manifest schema rejects is dropped from the
 * upgrade review — so every real name must pass it. Fails the moment an authoring
 * rule and the schema drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  releaseHostMigrationSchema, releasePlatformMigrationSchema, releaseSqlMigrationSchema,
} from '@insula/api-contracts';
import { compareVersions } from './semver.js';

const REPO = resolve(__dirname, '../../../../..');
const HM = join(REPO, 'platform/host-migrations');

describe('release-manifest names', () => {
  it('every host-migration script key passes; from 2026.10.7 its description does too', () => {
    const bad: string[] = [];
    for (const rel of readdirSync(HM).filter((d) => /^\d+\.\d+\.\d+$/.test(d))) {
      for (const f of readdirSync(join(HM, rel)).filter((n) => n.endsWith('.sh'))) {
        const head = readFileSync(join(HM, rel, f), 'utf8').split('\n').slice(0, 40);
        const desc = head.find((l) => /^#\s*description:/.test(l))?.replace(/^#\s*description:\s*/, '').trim();
        const phase = head.find((l) => /^#\s*phase:/.test(l))?.replace(/^#\s*phase:\s*/, '').split(/\s/)[0] ?? 'before-services';
        const needsDesc = compareVersions(rel, '2026.10.7') >= 0;
        const r = releaseHostMigrationSchema.safeParse({ key: `${rel}/${f}`, phase, description: desc ?? 'Fallback description from the file name' });
        if (!r.success || (needsDesc && !desc)) bad.push(`${rel}/${f}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every SQL migration and platform migration name passes', () => {
    const sqlBad = readdirSync(join(REPO, 'backend/src/db/migrations')).filter((n) => n.endsWith('.sql'))
      .filter((n) => !releaseSqlMigrationSchema.safeParse(n).success);
    const platBad = readdirSync(join(REPO, 'backend/src/modules/platform-upgrades/migrations'))
      .filter((n) => /^\d/.test(n) && n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .map((n) => n.slice(0, -3))
      .filter((n) => !releasePlatformMigrationSchema.safeParse(n).success);
    expect([...sqlBad, ...platBad]).toEqual([]);
  });
});
