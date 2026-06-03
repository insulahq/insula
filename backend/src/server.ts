import { loadConfig } from './config/index.js';
import { getDb, getPool, closeDb } from './db/index.js';
import { buildApp } from './app.js';
import { suspendExpiredTenants } from './modules/subscriptions/expiry-checker.js';
import { runAutoUpgradePass } from './modules/deployments/auto-upgrade-cron.js';
import { createK8sClients } from './modules/k8s-provisioner/k8s-client.js';
import { bootstrapSystemTenant } from './modules/system-tenant/bootstrap.js';
import { persistInstalledVersion } from './modules/platform-updates/service.js';

const config = loadConfig();
const db = getDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

// Declare the timer holder up front so the shutdown handler can
// reference it safely. SIGTERM that arrives before app.listen()
// completes (e.g. readiness probe failure during onReady) used to
// hit a TDZ on `expiryCheckTimer` and exit the container with
// ReferenceError, masking the real Fastify boot timeout in the logs.
let expiryCheckTimer: NodeJS.Timeout | null = null;
let autoUpgradeTimer: NodeJS.Timeout | null = null;

const shutdown = async () => {
  if (expiryCheckTimer) clearInterval(expiryCheckTimer);
  if (autoUpgradeTimer) clearInterval(autoUpgradeTimer);
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Server listening on port ${config.PORT}`);

// One k8s client set shared by the post-listen startup passes below (built
// once rather than per-IIFE). null when no kubeconfig is available (e.g. a
// unit-test boot) — every consumer treats that as "skip the cluster bits".
const startupK8s = (() => {
  try { return createK8sClients(config.KUBECONFIG_PATH); } catch { return null; }
})();

// SYSTEM tenant self-healing pass (ADR-040). Runs on every startup
// (~10 ms when the row already exists) so a Postgres restore from a
// pre-SYSTEM backup, or accidental direct-SQL deletion, gets caught
// before any operator action. seed.ts must have created hosting_plans
// + regions first; if missing, log and continue — the platform can
// still serve requests, just without an indelible SYSTEM row.
(async () => {
  try {
    const result = await bootstrapSystemTenant(db, {
      k8s: startupK8s,
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg, err) => app.log.warn({ err }, msg),
      },
    });
    if (result.created) {
      app.log.info(`[system-tenant] bootstrap created SYSTEM tenant ${result.tenantId}`);
    }
  } catch (err) {
    app.log.warn({ err }, '[system-tenant] startup bootstrap failed (continuing)');
  }
})();

// Version spine (ADR-045): record the running pod's version as the durable
// `installed_platform_version` so upgrade pre-flight/gating reads a value that
// survives pod restarts. No-op until PLATFORM_VERSION is wired; non-fatal.
(async () => {
  try {
    const v = await persistInstalledVersion(db);
    if (v) app.log.info(`[version-spine] installed_platform_version = ${v}`);
  } catch (err) {
    app.log.warn({ err }, '[version-spine] failed to persist installed version (continuing)');
  }
})();

// Platform-migration registry (W9 / ADR-045). Runs the pending TypeScript
// cluster-migrations (DaemonSets, baselines, reconciler enablement) exactly
// like the system-tenant + version-spine convergence passes above: AFTER
// listen, non-blocking. These are eventual-convergence steps, NOT serving
// prerequisites (the SQL *schema* migrations — which ARE prerequisites — run in
// the entrypoint before this process). Running post-listen means a slow/hung
// migration can never block boot or crashloop the pod. An HA peer holding the
// advisory lock skips. PLATFORM_SKIP_MIGRATIONS=1 is the escape hatch.
(async () => {
  try {
    const { runStartupMigrations } = await import('./modules/platform-upgrades/index.js');
    const result = await runStartupMigrations({
      db,
      pool: getPool(),
      k8s: startupK8s,
      config: { PLATFORM_VERSION: config.PLATFORM_VERSION, KUBECONFIG_PATH: config.KUBECONFIG_PATH },
      log: {
        info: (msg) => app.log.info(msg),
        warn: (msg, err) => app.log.warn({ err }, msg),
      },
      skip: process.env.PLATFORM_SKIP_MIGRATIONS === '1',
    });
    if (result.ran && result.failed) {
      // The runner HALTED the sequence (no later migration ran on a broken
      // base). The API keeps serving — convergence is idempotent + retried on
      // the next boot. Surfaced loud for the operator.
      app.log.error('[platform-migrations] a migration FAILED — sequence halted; API continues serving (idempotent retry next boot). See preceding warnings.');
    } else if (result.ran && result.applied > 0) {
      app.log.info(`[platform-migrations] applied ${result.applied} migration(s)`);
    }
  } catch (err) {
    // The runner never throws for a migration failure; this guards an infra
    // error (pool/DB). Non-fatal — the API serves regardless.
    app.log.warn({ err }, '[platform-migrations] runner errored (continuing)');
  }
})();

// Check for expired subscriptions every hour
const EXPIRY_CHECK_INTERVAL = 60 * 60 * 1000;
expiryCheckTimer = setInterval(async () => {
  try {
    const count = await suspendExpiredTenants(db);
    if (count > 0) {
      app.log.info(`Auto-suspended ${count} tenant(s) with expired subscriptions`);
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to check expired subscriptions');
  }
}, EXPIRY_CHECK_INTERVAL);

// Run immediately on startup
suspendExpiredTenants(db).catch((err) => {
  app.log.error({ err }, 'Failed initial expired subscription check');
});

// Auto-upgrade cron — runs every 24h. Opt-in per deployment via
// deployments.autoUpgrade=true. Strict apps are always skipped (handled
// inside runAutoUpgradePass + at the setAutoUpgrade API). The k8s tenant
// is lazily created; if no kubeconfig is available (e.g. unit-test boot),
// the cron is a no-op.
const AUTO_UPGRADE_INTERVAL = 24 * 60 * 60 * 1000;
const getAutoUpgradeK8s = () => {
  try {
    return createK8sClients(config.KUBECONFIG_PATH);
  } catch {
    return null;
  }
};
autoUpgradeTimer = setInterval(async () => {
  try {
    const result = await runAutoUpgradePass(db, getAutoUpgradeK8s());
    if (result.upgraded > 0 || result.failed > 0) {
      app.log.info(
        `[auto-upgrade] attempted=${result.attempted} upgraded=${result.upgraded} skipped=${result.skipped} failed=${result.failed}`,
      );
    }
    if (result.failures.length > 0) {
      for (const f of result.failures) {
        app.log.warn(`[auto-upgrade] deployment ${f.deploymentId}: ${f.error}`);
      }
    }
  } catch (err) {
    app.log.error({ err }, 'Auto-upgrade cron pass failed');
  }
}, AUTO_UPGRADE_INTERVAL);
