/**
 * ACME HTTP-01 override IngressRoute for a non-default mail hostname.
 *
 * **The gap this closes** — Stalwart manages its own TLS cert via
 * native ACME HTTP-01. Let's Encrypt validates ownership by
 * GET-ting `http://<mailhost>/.well-known/acme-challenge/<token>`.
 * Traefik owns :80 and forwards that path to Stalwart's `http-acme`
 * listener via the STATIC IngressRoute
 * `k8s/base/stalwart-mail/stalwart/ingress-acme.yaml` — but that route
 * is pinned to `Host(`mail.${DOMAIN}`)` (the default mail hostname).
 *
 * When an operator RENAMES the mail hostname to a non-default value
 * (`platform_settings.mail_server_hostname`), the
 * stalwart-domain-reconciler points Stalwart's cert anchor at the
 * override host — but Traefik has no acme route for that host, so the
 * HTTP-01 challenge 404s at Traefik and the renamed host's cert never
 * issues.
 *
 * **Design** — rather than fight Flux over the static object's
 * `routes` array (Flux re-applies the base manifest on every git
 * sync), the platform-api owns a SEPARATE IngressRoute named
 * `stalwart-mail-acme-override`. It is created only when the mail
 * hostname differs from the default `mail.<ingress_base_domain>`, and
 * deleted (absence-reconciled) when the hostname is empty OR equals
 * the default — so a rename back to default cleans itself up.
 *
 * Idempotent + best-effort: never throws fatally (mirrors the
 * stalwart-domain-reconciler style). Self-heals every reconciler tick
 * AND applies inline on every hostname-rename PATCH. The apply path
 * reuses the ingress-routes module's create-or-replace helper
 * (`applyIngressRoute`) so the k8s-client interaction matches every
 * other Traefik IngressRoute the platform-api owns.
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';

import { eq } from 'drizzle-orm';

import { applyIngressRoute, deleteIngressRoute } from '../ingress-routes/traefik-apply.js';
import type { IngressRouteBody } from '../ingress-routes/traefik-types.js';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/** Namespace + name of the platform-api-owned override IngressRoute. */
export const MAIL_ACME_OVERRIDE_NAMESPACE = 'mail';
export const MAIL_ACME_OVERRIDE_NAME = 'stalwart-mail-acme-override';

/** Backend Service the override route forwards to (Stalwart http-acme listener). */
const ACME_SERVICE_NAME = 'stalwart-mail-acme';
const ACME_SERVICE_PORT = 80;

interface OverrideRouteLogger {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

/**
 * RFC-1123 DNS-hostname check. Defensive guard so the resolved mail
 * hostname can NEVER be interpolated raw into the Traefik match rule
 * `Host(`<host>`) && …` (`buildOverrideRouteBody`). A crafted value
 * with backticks/parentheses (e.g. `` x`)||Host(`evil.com ``) could
 * otherwise inject or widen the route. The write-boundary Zod schema
 * (`@insula/api-contracts` webmail-settings / platform-urls) enforces
 * the same constraint, but this guard keeps the reconciler safe even if
 * an invalid value somehow already exists in the DB (legacy rows,
 * direct SQL edits, etc.).
 *
 * Mirrors the schema regex: total length 1..253, dot-separated labels
 * of `[a-z0-9]` optionally containing internal hyphens, at least two
 * labels (a bare single-label host is rejected — the mail host is
 * always an FQDN `mail.<apex>` or an operator override FQDN).
 */
const MAIL_HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidMailHostname(host: string): boolean {
  return MAIL_HOSTNAME_RE.test(host);
}

/**
 * Resolve the default mail hostname (`mail.<ingress_base_domain>`).
 * Mirrors getExplicitMailHostname's apex normalisation: strip
 * trailing dots, lowercase. Returns null when the apex is unset (the
 * platform isn't fully bootstrapped — the override route can't be
 * compared against a default that doesn't exist, so we no-op).
 */
export async function resolveDefaultMailHost(db: Database): Promise<string | null> {
  try {
    const [apexRow] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, 'ingress_base_domain'));
    const apex = apexRow?.value?.trim().replace(/\.+$/, '').toLowerCase();
    if (!apex || apex.length === 0) return null;
    return `mail.${apex}`;
  } catch {
    return null;
  }
}

/**
 * Build the override IngressRoute manifest for a given mail hostname.
 * Mirrors the static `stalwart-mail-acme` route (entryPoint `web`,
 * PathPrefix acme-challenge, priority 100, backend stalwart-mail-acme:80)
 * but matches the OVERRIDE host instead of `mail.${DOMAIN}`.
 */
export function buildOverrideRouteBody(mailHostname: string): IngressRouteBody {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: MAIL_ACME_OVERRIDE_NAME,
      namespace: MAIL_ACME_OVERRIDE_NAMESPACE,
      labels: {
        // Mirror the static route's identity labels…
        'app.kubernetes.io/name': 'stalwart-mail',
        'app.kubernetes.io/component': 'acme-http01',
        // …plus ownership so operators (and CI) can tell this object
        // is reconciled by the platform-api, not shipped via Flux.
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      entryPoints: ['web'],
      routes: [
        {
          match: `Host(\`${mailHostname}\`) && PathPrefix(\`/.well-known/acme-challenge/\`)`,
          kind: 'Rule',
          priority: 100,
          services: [{ name: ACME_SERVICE_NAME, port: ACME_SERVICE_PORT }],
        },
      ],
    },
  };
}

/**
 * Reconcile the override IngressRoute for the current mail hostname.
 *
 * - `mailHostname` empty OR equal to `defaultMailHost` → ensure the
 *   override route is ABSENT (delete; ignore 404).
 * - otherwise → create/replace the override route (idempotent via
 *   `applyIngressRoute`'s read-then-replace fallback).
 *
 * `defaultMailHost` null (apex unbootstrapped) → the default is only
 * needed to decide whether an override would be REDUNDANT, so a
 * non-empty, VALID hostname STILL gets its override route applied; an
 * empty hostname still deletes. (Note: because the override route is
 * keyed off the stored hostname, an apex change can leave a prior-apex
 * override route in place — by design; it is cleaned up the next time
 * the hostname is reset to the new default or emptied.)
 *
 * H1 defensive guard: a non-empty hostname that fails the RFC-1123
 * check is NEVER passed to `buildOverrideRouteBody` (which would emit a
 * corrupt/injected Traefik match) — we log.warn and skip the apply,
 * while still allowing the delete-when-default/empty path to run.
 *
 * Never throws — logs a warning and returns on any k8s error.
 */
export async function ensureMailAcmeOverrideRoute(
  custom: CustomObjectsApi,
  mailHostname: string | null | undefined,
  defaultMailHost: string | null,
  log: OverrideRouteLogger,
): Promise<void> {
  const host = mailHostname?.trim().toLowerCase() ?? '';
  const dflt = defaultMailHost?.trim().toLowerCase() ?? '';

  // Empty host OR host equal to the (known) default → ensure ABSENT.
  // When `dflt` is empty (apex unbootstrapped) we can't say a non-empty
  // host is "default", so it falls through to the apply branch (M2): a
  // valid non-default host still gets its override route.
  const needsOverride = host.length > 0 && host !== dflt;

  if (!needsOverride) {
    try {
      await deleteIngressRoute(custom, MAIL_ACME_OVERRIDE_NAMESPACE, MAIL_ACME_OVERRIDE_NAME);
      log.info(
        `mail-acme-override: hostname '${host || '(empty)'}' is default (or unset) — ensured override IngressRoute '${MAIL_ACME_OVERRIDE_NAME}' absent`,
      );
    } catch (err) {
      log.warn(
        `mail-acme-override: delete of IngressRoute '${MAIL_ACME_OVERRIDE_NAME}' failed (non-fatal, will retry next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }

  // H1: defensive validation — never interpolate an invalid host into
  // the Traefik match rule. Skip the apply (a corrupt/injected route is
  // worse than no route); the delete path above is unaffected.
  if (!isValidMailHostname(host)) {
    log.warn(
      `mail-acme-override: refusing to apply IngressRoute '${MAIL_ACME_OVERRIDE_NAME}' — mail hostname '${host}' is not a valid DNS hostname (potential Traefik match injection); skipping apply`,
    );
    return;
  }

  try {
    await applyIngressRoute(custom, buildOverrideRouteBody(host));
    log.info(
      `mail-acme-override: applied IngressRoute '${MAIL_ACME_OVERRIDE_NAME}' for override host '${host}' → ${ACME_SERVICE_NAME}:${ACME_SERVICE_PORT}`,
    );
  } catch (err) {
    log.warn(
      `mail-acme-override: apply of IngressRoute '${MAIL_ACME_OVERRIDE_NAME}' failed (non-fatal, will retry next tick): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
