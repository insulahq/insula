import fs from 'node:fs';
import path from 'node:path';
import {
  stalwartCredentialsResponseSchema,
  type StalwartCredentialsResponse,
} from '@insula/api-contracts';

/**
 * Resolve the Stalwart fallback-admin credentials.
 *
 * Sources (first match wins):
 *   1. Secret volume mount at STALWART_ADMIN_CREDS_DIR (default
 *      `/etc/stalwart-creds`). The Rotate endpoint patches the k8s
 *      Secret; kubelet refreshes the mounted file within ~60s, so
 *      platform-api picks up rotations without a pod restart.
 *   2. STALWART_ADMIN_PASSWORD env (legacy, still honored)
 *   3. STALWART_ADMIN_SECRET_PLAIN / ADMIN_SECRET_PLAIN (older names)
 *
 * Throws when nothing works — the route converts that into a 503.
 */
export function readStalwartCredentials(env: NodeJS.ProcessEnv): StalwartCredentialsResponse {
  const rawPassword =
    readPasswordFromFile(env) ??
    env.STALWART_ADMIN_PASSWORD ??
    env.STALWART_ADMIN_SECRET_PLAIN ??
    env.ADMIN_SECRET_PLAIN ??
    '';
  const password = rawPassword.trim();
  if (!password) {
    throw new Error(
      'Stalwart admin password is not configured — expected a mounted secret at STALWART_ADMIN_CREDS_DIR/ADMIN_SECRET_PLAIN or the STALWART_ADMIN_PASSWORD env var.',
    );
  }
  const rawUsername = env.STALWART_ADMIN_USER?.trim();
  const username = rawUsername && rawUsername.length > 0 ? rawUsername : 'admin';

  // Pass through the shared schema so response shape stays in lockstep
  // with the contract package even if the fields evolve.
  return stalwartCredentialsResponseSchema.parse({ username, password });
}

function readPasswordFromFile(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.STALWART_ADMIN_CREDS_DIR?.trim();
  if (!dir) return undefined;
  const file = path.join(dir, 'ADMIN_SECRET_PLAIN');
  try {
    const content = fs.readFileSync(file, 'utf8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    // Missing file → fall back to env. Don't log; this is the expected
    // path in unit tests and non-mounted deployments.
    return undefined;
  }
}

/**
 * Same credentials, but read from the Kubernetes Secret rather than from the
 * volume mount of it.
 *
 * WHY BOTH EXIST
 * --------------
 * Rotation patches `platform/platform-stalwart-creds`, and platform-api mounts
 * that Secret at `STALWART_ADMIN_CREDS_DIR`. **Kubelet refreshes a mounted
 * Secret lazily — up to ~60s.** For everything that merely authenticates to
 * Stalwart, that lag is harmless: the call retries and succeeds a moment later.
 *
 * For the admin UI's "Show Stalwart Credentials" it was not harmless, and
 * produced a reproducible wrong answer. The rotate mutation seeds React Query
 * with the new password, but the credentials query is deliberately
 * `staleTime: 0` + `refetchOnMount: 'always'` — so the refetch that fires
 * straight after re-read the not-yet-refreshed FILE and overwrote the correct
 * value with the OLD password. The operator saw the previous password, and it
 * only corrected itself after a reload more than a minute later, which is
 * exactly the reported symptom. The freshness setting intended to guarantee
 * correctness was what broke it.
 *
 * Reading the Secret through the API removes the window instead of racing it,
 * and is HA-safe: an in-process cache on the rotating replica would still serve
 * the old value from the other replicas.
 *
 * Falls back to the file/env reader on any failure, so a missing RBAC grant or
 * an API blip degrades to the previous behaviour rather than breaking the
 * reveal entirely.
 */
export async function readStalwartCredentialsAuthoritative(
  env: NodeJS.ProcessEnv,
  readSecret: (ns: string, name: string) => Promise<Record<string, string> | undefined>,
): Promise<StalwartCredentialsResponse> {
  const ns = env.STALWART_CREDS_SECRET_NAMESPACE?.trim() || 'platform';
  const name = env.STALWART_CREDS_SECRET_NAME?.trim() || 'platform-stalwart-creds';
  try {
    const data = await readSecret(ns, name);
    const b64 = data?.ADMIN_SECRET_PLAIN;
    if (b64) {
      const password = Buffer.from(b64, 'base64').toString('utf8').trim();
      if (password) {
        const rawUsername = env.STALWART_ADMIN_USER?.trim();
        return stalwartCredentialsResponseSchema.parse({
          username: rawUsername && rawUsername.length > 0 ? rawUsername : 'admin',
          password,
        });
      }
    }
  } catch {
    // Fall through — the mounted file is still correct once kubelet catches up.
  }
  return readStalwartCredentials(env);
}
