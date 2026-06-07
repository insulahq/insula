---
verified: 2026.6.7
---

# Security model

Insula is built defense-in-depth: who can do what (roles), tenants can't reach
each other (isolation), the edge filters hostile traffic (defense), everything
is encrypted in transit (TLS), logins are strong (passkeys/2FA), and every
sensitive action is recorded (audit log). This page is the high-level map;
operators should follow the security-hardening runbook for day-2 detail.

## Roles

Access is role-based and split across two panels. The backend enforces which
panel each user can reach from a claim in their token.

**Staff (admin panel):**

| Role | Can do |
|---|---|
| `super_admin` | Everything, including OIDC config, user management, node terminal |
| `admin` | Manage tenants, domains, workloads, backups — not platform-level config |
| `billing` | Subscriptions, invoices, plan changes |
| `support` | Read tenants and assist (domains, databases, backups); can impersonate |
| `read_only` | Dashboards, metrics, status only |

**Tenant (tenant panel):**

| Role | Can do |
|---|---|
| `tenant_admin` | Full control of their own tenant, including sub-users |
| `tenant_user` | Read-only view of their own tenant |

Staff with `super_admin`, `admin`, or `support` can **impersonate** a tenant to
help them — every impersonated action is logged with the acting admin's ID, and
the impersonation token has a short (1-hour) lifetime.

## Isolation layers

Each tenant is fenced off at three levels at once:

- **Namespace** — a dedicated `client-{id}` Kubernetes namespace per tenant.
- **Network policy** — default-deny, with explicit allows only for the ingress
  controller and platform services. Cross-tenant pod traffic is blocked.
- **Resource quota** — CPU, memory, and storage caps from the tenant's plan
  bound the blast radius of any single tenant.

## Edge defense

Inbound web traffic passes through two WAF layers at the Traefik edge
(ADR-038):

- **CrowdSec** — an IP-reputation bouncer runs on **every** route, dropping
  known-bad IPs using a community blocklist refreshed hourly.
- **ModSecurity + OWASP CRS** — a payload-inspecting WAF, **opt-in per tenant
  route** (off by default to avoid false positives), and **always-on** for the
  admin and tenant panels.

At the host level, **fail2ban** bans IPs that brute-force SSH/SFTP/mail. An
operator can also maintain a cluster-wide firewall blacklist.

## TLS everywhere

Every public route gets a free Let's Encrypt certificate via cert-manager,
renewed automatically. Mail listeners use TLS/STARTTLS. Panel and API traffic
is HTTPS-only.

## Logins: passkeys and step-up 2FA

The platform supports **passkeys** (WebAuthn) alongside passwords and external
OIDC (Google/Apple via an external provider, ADR-022). Sensitive admin
actions — like opening a node terminal — require a fresh **step-up** credential
challenge within a short freshness window, so a stolen session alone isn't
enough.

## Audit log

Sensitive actions — tenant lifecycle changes, impersonation, HA changes,
app-password views, backups/restores — are written to an append-only audit log
with the actor, timestamp, and before/after detail. It's visible in the admin
panel under **Audit Logs**.

!!! note "What this page is not"
    This is the conceptual map. For SSH lockdown, mesh detection, CIS-style node
    checks, cert-expiry tracking, and the rest of the operator-facing posture
    tooling, see the security-hardening operator guide.

??? info "Under the hood"
    - Tokens are JWTs validated on every request (RS256, issuer/audience/expiry
      checks) with a server-side denylist for instant revocation; panel
      enforcement and client-scope checks run as middleware.
    - Some designs in older architecture docs deviate from what's shipped:
      fail2ban runs **host-level** (not as a DaemonSet), sealed-secrets is
      installed by bootstrap, and service-to-service mTLS is **not** implemented
      (network-policy segmentation only). Trivy image scanning is intentionally
      deferred.
    - Authoritative sources:
      [RBAC_PERMISSION_MODEL.md](https://github.com/insulahq/insula/blob/main/docs/architecture/RBAC_PERMISSION_MODEL.md),
      [SECURITY_ARCHITECTURE.md](https://github.com/insulahq/insula/blob/main/docs/architecture/SECURITY_ARCHITECTURE.md),
      [ADR-038](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-038-traefik-waf-architecture.md),
      [SECURITY_HARDENING.md](https://github.com/insulahq/insula/blob/main/docs/operations/SECURITY_HARDENING.md).
