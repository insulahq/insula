# @insula/tenant-panel

The **tenant/customer** UI for Insula — the self-service panel where hosted
customers manage their own websites, domains, databases, mailboxes, and
backups. React 18 + Vite + Tailwind + shadcn/ui, dev server on **port 5174**.

## Stack

- React 18 + Vite + TypeScript
- Tailwind CSS + shadcn/ui
- **TanStack Query** (server state) + **Zustand** (client state)
- Types from [`@insula/api-contracts`](../../packages/api-contracts) via
  `z.infer` — no locally-defined API types

Same shape as the [admin panel](../admin-panel) but scoped to a single tenant's
resources (tenant-role JWT; the API enforces tenant isolation server-side).

## Commands

```bash
npm run dev          # Vite dev server on :5174
npm run build        # tsc -b && vite build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test         # vitest
```

## Production image

Serves the built SPA via nginx and reverse-proxies `/api/*` to `platform-api`
in-cluster.

> **Edit `nginx.conf.template`, not `nginx.conf`.** The entrypoint `envsubst`s
> the template at startup and overwrites `default.conf`.

## Build the shared package first

```bash
node ../../node_modules/typescript/bin/tsc -b ../../packages/api-contracts --force
```

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md).
