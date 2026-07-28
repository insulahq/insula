import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgresql://')).or(z.string().startsWith('postgres://')),
  JWT_SECRET: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().optional(),
  PLATFORM_ENCRYPTION_KEY: z.string().min(32).optional(),
  KUBECONFIG_PATH: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PLATFORM_ENV: z.enum(['development', 'dev', 'staging', 'production']).default('development'),
  PLATFORM_VERSION: z.string().default('0.1.0'),
  PLATFORM_INTERNAL_SECRET: z.string().optional(),
  DEFAULT_STORAGE_CLASS: z.string().default('local-path'),
  INGRESS_BASE_DOMAIN: z.string().optional(),
  // Canonical apex domain. All service subdomains (admin, tenant, dex,
  // webmail, mail, stalwart) derive from this in
  // backend/src/config/domains.ts. INGRESS_BASE_DOMAIN above is kept as a
  // legacy fallback alias so existing ConfigMaps don't break; prefer
  // PLATFORM_BASE_DOMAIN on new deploys.
  PLATFORM_BASE_DOMAIN: z.string().optional(),
  INGRESS_DEFAULT_IPV4: z.string().optional(),
  CLUSTER_ISSUER_NAME: z.string().optional(),
  // Secret that holds the TLS cert for the platform Ingress. The ingress
  // reconciler stamps this into spec.tls[0].secretName on every PATCH of
  // admin/tenant panel URLs. Set via platform-config ConfigMap (dev:
  // platform-dev-tls, prod: platform-tls).
  PLATFORM_TLS_SECRET_NAME: z.string().optional(),
  PLATFORM_NAMESPACE: z.string().default('platform'),
  FILE_MANAGER_IMAGE: z.string().default('ghcr.io/insulahq/insula/file-manager:latest'),
  // Private Worker — overlay-supplied. TUNNEL_BASE_URL is the public WSS
  // dial-in (e.g. wss://tunnels.staging.example.test). The agent token
  // blob's server_url field is built from this. The frps image is the
  // cluster-side tunnel server; the agent image is what the tenant runs at
  // home (only referenced from generated docker-compose snippets).
  TUNNEL_BASE_URL: z.string().default('wss://tunnels.example.com'),
  PRIVATE_WORKER_FRPS_IMAGE: z.string().default('fatedier/frps:v0.62.1'),
  PRIVATE_WORKER_AGENT_IMAGE: z
    .string()
    .default('ghcr.io/insulahq/insula/private-worker-agent:latest'),
  // Storage-lifecycle snapshot store. Dev default = hostPath; prod
  // operators would swap to s3 + credentials via the STORAGE_SNAPSHOT_*
  // prefix. STORAGE_SNAPSHOT_HOST_ROOT is the path ON THE NODE the
  // hostPath mounts; STORAGE_SNAPSHOT_LOCAL_ROOT is where the same dir
  // appears inside the platform-api container for stat/delete.
  STORAGE_SNAPSHOT_BACKEND: z.string().default('hostpath'),
  STORAGE_SNAPSHOT_HOST_ROOT: z.string().default('/var/lib/platform/snapshots'),
  STORAGE_SNAPSHOT_LOCAL_ROOT: z.string().default('/snapshots'),
  DISABLE_RATE_LIMIT: z.string().optional(),
  // Domain attribute for the platform_session cookie. Empty → host-only
  // (admin.<apex> only). Set to `.<apex>` to share the session across
  // subdomains (required for the Stalwart web-admin auth_request gate).
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  // Canonical public origin for URLs we emit back to tenants (e.g. the
  // CRL distribution point in mTLS provider metadata). Derived from
  // configuration — NOT request headers — to prevent X-Forwarded-Host
  // injection into stored/displayed URLs. Example:
  //   https://admin.staging.example.test
  PUBLIC_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const message = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(', ')}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${message}`);
  }
  const config = result.data;
  assertEncryptionKeyUsable(config);
  return config;
}

/**
 * Environments that hold real tenant/operator credentials and must therefore
 * refuse to boot without a usable PLATFORM_ENCRYPTION_KEY. `development` and
 * the zod default are excluded so local dev / unit tests keep working with
 * the zero-key fallback the call sites provide.
 */
const KEY_REQUIRED_ENVS: ReadonlySet<Config['PLATFORM_ENV']> = new Set([
  'production', 'staging',
] as const);

/** 32 bytes, hex-encoded — exactly what `openssl rand -hex 32` emits. */
const ENCRYPTION_KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Fail CLOSED on a missing or malformed encryption key.
 *
 * WHY (2026-07-28 security review): `PLATFORM_ENCRYPTION_KEY` is optional and
 * ~40 call sites fall back to `'0'.repeat(64)` — an all-zero, publicly known
 * AES key. Previously an unset key in production only printed a CRITICAL line
 * and then carried on, silently "encrypting" DNS-provider credentials, OIDC
 * client secrets, backup-target secrets, mTLS keys and Plesk source passwords
 * under a key any reader of this repo knows.
 *
 * Rather than rewrite 40 call sites (a large diff with 40 chances to miss
 * one), the gate is here: if the key is unusable, a credential-bearing
 * environment never starts, so no zero-key ciphertext can ever be produced.
 * The dev-only fallbacks stay exactly as they are.
 *
 * Shape is validated too: `Buffer.from(key, 'hex')` parses up to the first
 * non-hex character, so a 32-character passphrase silently becomes a short
 * key and every cipher call throws at RUNTIME (mid-request) instead of at
 * boot. Catch it once, here.
 */
export function assertEncryptionKeyUsable(config: Config): void {
  const key = config.PLATFORM_ENCRYPTION_KEY;
  const required = KEY_REQUIRED_ENVS.has(config.PLATFORM_ENV);

  if (!key) {
    if (required) {
      throw new Error(
        `[config] PLATFORM_ENCRYPTION_KEY is required when PLATFORM_ENV=${config.PLATFORM_ENV}. `
        + 'Refusing to start: without it, stored credentials (DNS providers, OIDC client '
        + 'secrets, backup targets, mTLS keys) would be encrypted with an all-zero key. '
        + 'Generate one with `openssl rand -hex 32` and set it via the platform-secrets '
        + 'Secret (key: platform-encryption-key).',
      );
    }
    console.warn(
      `[config] PLATFORM_ENCRYPTION_KEY is not set (PLATFORM_ENV=${config.PLATFORM_ENV}). `
      + 'Stored credentials use a zero key — DEV/TEST ONLY, never for real data.',
    );
    return;
  }

  if (!ENCRYPTION_KEY_RE.test(key)) {
    throw new Error(
      '[config] PLATFORM_ENCRYPTION_KEY must be 64 hex characters (32 bytes), '
      + `got ${key.length} character(s) that do not match /^[0-9a-f]{64}$/i. `
      + 'Generate one with `openssl rand -hex 32`.',
    );
  }
}
