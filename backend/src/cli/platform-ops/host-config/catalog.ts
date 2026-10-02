/**
 * Host-migration catalog loading (ADR-045 W10c) — shared by the converge runner
 * and `host-config baseline` (ADR-056 §5), which must see EXACTLY the same set of
 * scripts: a baseline computed over a different catalog than the one the runner
 * walks would stamp the wrong things. Extracted verbatim from index.ts.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostMigrationValid } from './host-migrations.js';
import type { HostMigrationScript } from './types.js';

// The filesystem dir is the dev/escape-hatch catalog source (production is SEA-embedded).
const DEFAULT_HOST_MIGRATIONS_DIR = '/usr/local/share/platform-ops/host-migrations';

export function splitMigrationKey(key: string): { version: string; name: string } {
  const slash = key.indexOf('/');
  if (slash < 0) return { version: '', name: key };
  return { version: key.slice(0, slash), name: key.slice(slash + 1) };
}

/** Parse a catalog dir on disk: <root>/<version>/<NNNN-name.sh>. */
function loadFilesystemCatalog(dir: string): HostMigrationScript[] {
  const out: HostMigrationScript[] = [];
  let versions: string[] = [];
  try {
    versions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const version of versions) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, version)).filter((f) => f.endsWith('.sh'));
    } catch {
      continue;
    }
    for (const name of files) {
      // Only read files that pass validation — never touch an odd path.
      if (!hostMigrationValid({ version, name })) {
        out.push({ version, name, key: `${version}/${name}`, body: '' });
        continue; // surfaced as "invalid" by the runner; body unused
      }
      try {
        const body = readFileSync(join(dir, version, name), 'utf8');
        out.push({ version, name, key: `${version}/${name}`, body });
      } catch {
        // unreadable → skip; absence is benign
      }
    }
  }
  return out;
}

/**
 * Load the shipped catalog: SEA-embedded assets in production (so scripts travel
 * with every self-upgrade), or a filesystem dir in dev / as an escape hatch.
 */
export async function loadHostMigrationCatalog(
  env: NodeJS.ProcessEnv,
): Promise<{ source: 'embedded' | 'filesystem' | 'absent'; scripts: HostMigrationScript[] }> {
  // 1. SEA-embedded (the production path). Distinguish "not a SEA" from "is a SEA
  // but the assets won't load": a real SEA binary ALWAYS carries the manifest, so
  // an asset failure means a CORRUPT binary — refuse outright rather than silently
  // falling through to the lower-trust filesystem (which would let a node that
  // self-upgraded into a bad binary execute env/dir-pointed scripts as root).
  let sea: typeof import('node:sea') | null = null;
  try {
    sea = await import('node:sea');
  } catch {
    sea = null; // not a SEA runtime (dev / tests / plain node)
  }
  if (sea?.isSea()) {
    try {
      const manifestRaw = sea.getAsset('host-migrations/manifest.json', 'utf8') as string;
      const manifest = JSON.parse(manifestRaw) as { scripts?: string[] };
      const scripts: HostMigrationScript[] = [];
      for (const key of manifest.scripts ?? []) {
        const { version, name } = splitMigrationKey(key);
        const body = sea.getAsset(`host-migrations/${key}`, 'utf8') as string;
        scripts.push({ version, name, key, body });
      }
      return { source: 'embedded', scripts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`host-config: embedded host-migration catalog unreadable (corrupt binary?) — refusing: ${msg}\n`);
      return { source: 'absent', scripts: [] };
    }
  }
  // 2. Filesystem — dev / non-SEA only (NEVER reached from a real node binary).
  const dir = env.PLATFORM_OPS_HOST_MIGRATIONS_DIR?.trim() || DEFAULT_HOST_MIGRATIONS_DIR;
  if (!existsSync(dir)) return { source: 'absent', scripts: [] };
  return { source: 'filesystem', scripts: loadFilesystemCatalog(dir) };
}
