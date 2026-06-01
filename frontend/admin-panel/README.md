# @insula/admin-panel

The **operator/admin** UI for Insula — manage tenants, domains, databases,
mail, backups, storage, security/hardening, and cluster operations. React 18 +
Vite + Tailwind + shadcn/ui, dev server on **port 5173**.

## Stack

- React 18 + Vite + TypeScript
- Tailwind CSS + shadcn/ui
- **TanStack Query** (server state) + **Zustand** (client state)
- Types from [`@insula/api-contracts`](../../packages/api-contracts) via
  `z.infer` — no locally-defined API types

## Commands

```bash
npm run dev          # Vite dev server on :5173
npm run build        # tsc -b && vite build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test         # vitest
```

The dev server expects the backend API reachable at `/api/*`. Against the local
stack (`./scripts/local.sh up`) it is served through the panel's nginx; for a
standalone `npm run dev`, point `/api` at a running backend (`:3000`).

## Production image

The container serves the built SPA via nginx and reverse-proxies `/api/*` to
`platform-api` in-cluster.

> **Edit `nginx.conf.template`, not `nginx.conf`.** The entrypoint runs
> `envsubst` on the template at startup and **overwrites** `default.conf` — any
> hand-edit to `nginx.conf` is discarded.

## Build the shared package first

```bash
node ../../node_modules/typescript/bin/tsc -b ../../packages/api-contracts --force
```

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md).
