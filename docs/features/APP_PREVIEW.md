# App Preview (route-less deployment preview)

Both panels show a **Preview** button next to Start/Stop for running catalog
and custom deployments. It opens the app in a sandboxed iframe **without any
ingress route** — useful to verify an app came up before wiring DNS/TLS.

## Mechanism

1. Panel POSTs `POST /api/v1/tenants/:tenantId/deployments/:id/preview-session`
   (Bearer; same tenant-access rules as the deployment routes). The backend
   resolves the deployment's ClusterIP Service targets with the SAME naming
   rules the deployers use (catalog: `k8s-deployer` single/multi-component
   naming; custom: `serviceObjectName` per exposed port), picks the primary
   (the port an ingress route would bind to), and returns a proxy URL.
2. The URL is `/api/v1/preview/<token>/` — same origin as the panel (nginx
   forwards `/api/v1` to platform-api), so the iframe needs no CORS and no
   cookie plumbing.
3. `ALL /api/v1/preview/:token/*` streams to
   `http://<svc>.<ns>.svc.cluster.local:<port>` (platform-api runs in-cluster).

## Token

Stateless HMAC (`backend/src/modules/app-preview/token.ts`): payload
`{v, ns, svc, port, exp}` signed with `PLATFORM_INTERNAL_SECRET`, 15-minute
TTL, constant-time verify. HA-safe with any replica count, and the target
tuple is pinned inside the signature — the proxy has **no** SSRF surface
(nothing in the path/query selects the destination).

## Security model (the proxied content is tenant-controlled)

- Every proxied response gets `Content-Security-Policy: sandbox allow-scripts
  allow-forms` — the browser treats the content as an opaque origin even when
  the URL is opened in a top-level tab, so app JS can never read the panel's
  cookies/localStorage. The iframe additionally sets the equivalent `sandbox`
  attribute (defense-in-depth).
- Inbound `Cookie` + `Authorization` are stripped (panel credentials never
  reach the workload); outbound `Set-Cookie` is stripped (a workload cannot
  plant cookies on the panel origin); `X-Frame-Options`/upstream CSP/HSTS are
  stripped so the iframe renders; `X-Robots-Tag: noindex` is added.
- Path-absolute `Location` redirects are rewritten into the token prefix.

## Known limitations (accepted for v1)

- Apps that reference assets by absolute path (`/style.css`) 404 inside the
  prefix proxy — the footer says so and recommends assigning a route.
- App sessions/logins don't work (cookies are blocked by the sandbox — by
  design).
- WebSockets are not proxied.
- Only path-absolute `Location` redirects are rewritten into the token
  prefix; a scheme-absolute redirect (`Location: https://…`) navigates the
  frame away from the proxy. Same class of exit as tenant JS setting
  `window.location` (which `allow-scripts` permits) — the sandbox CSP means
  the destination still gains nothing from the panel origin.

## NetworkPolicy

Tenant-namespace `allow-platform-api` no longer pins ports (was TCP/8111 for
the file-manager only): the preview proxy reaches arbitrary workload Service
ports, and platform-api holds cluster-admin credentials anyway, so the port
pin added no real boundary. The peer selector (platform ns + `app:
platform-api`) is unchanged. Existing tenant namespaces converge via the
startup network-policy reconcile.
