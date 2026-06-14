#!/usr/bin/env node
/**
 * platform-domain-rename — in-pod CLI entrypoint for `platform-ops domain rename`.
 *
 * Runs INSIDE the platform-api pod (via `kubectl exec`), exactly like the
 * `POST /admin/platform-domain/rename` route — same `renamePlatformDomain`
 * service, same `app.config`, same in-cluster k8s + DATABASE_URL. The host-side
 * command (backend/src/cli/platform-ops/domain.ts) execs this.
 *
 * Why in-pod and not in the SEA binary: `renamePlatformDomain`'s transitive
 * graph (→ oidc/service → bcrypt, plus other native deps) loads native `.node`
 * bindings that don't resolve in the bare-host SEA binary. The pod has
 * node_modules, so the service runs unmodified there. (Proven the hard way: an
 * in-binary attempt left the panels reconcile half-applied.)
 *
 * Inputs:  --to <apex>   the new platform apex (REQUIRED)
 * Output:  one JSON line on stdout: {"ok":true,"result":{…}} | {"ok":false,…}.
 * Exit:    0 ok · 1 rename failed · 2 setup error (no --to / no DATABASE_URL).
 */
import { loadConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/index.js';
import { renamePlatformDomain } from '../modules/platform-domain/service.js';

function fail(code: number, msg: string): never {
  process.stderr.write(`platform-domain-rename: ${msg}\n`);
  process.exit(code);
}

function parseTo(argv: string[]): string {
  const i = argv.indexOf('--to');
  const v = i === -1 ? undefined : argv[i + 1];
  if (!v) fail(2, '--to <apex> is required');
  return v;
}

async function main(): Promise<void> {
  const newApex = parseTo(process.argv.slice(2));
  const config = loadConfig();
  const db = getDb(config.DATABASE_URL);
  try {
    const result = await renamePlatformDomain(
      {
        db,
        // The whole app config — identical to what the API route passes, so the
        // CLI and the API resolve KUBECONFIG_PATH / CLUSTER_ISSUER_NAME /
        // PLATFORM_TLS_SECRET_NAME the same way.
        config: config as unknown as Record<string, unknown>,
        log: {
          info: (obj: unknown, msg?: string) => process.stderr.write(`[rename] ${msg ?? (typeof obj === 'string' ? obj : '')}\n`),
          warn: (obj: unknown, msg?: string) => process.stderr.write(`[rename] WARN ${msg ?? (typeof obj === 'string' ? obj : JSON.stringify(obj))}\n`),
        },
      },
      newApex,
    );
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (err) {
    // renamePlatformDomain throws ApiError(INVALID_FIELD_VALUE, 400) on a bad apex.
    const code = (err as { code?: string } | null)?.code;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        errorCode: code === 'INVALID_FIELD_VALUE' ? 'INVALID_APEX' : 'RENAME_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
