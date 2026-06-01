# @insula/backend

The Insula **management API** — a Node.js 22 / Fastify 4 / TypeScript service
that drives the whole platform: tenants, domains, databases, mail, backups,
DNS, TLS, storage, and cluster operations. Served on **port 3000**, never
exposed publicly — the admin and tenant panels reverse-proxy `/api/*` to it
in-cluster.

## Stack

- **Fastify 4** + TypeScript 5
- **Drizzle ORM** on **PostgreSQL** (CloudNativePG-managed in-cluster)
- **Zod** validation via [`@insula/api-contracts`](../packages/api-contracts) —
  all request/response types come from there, never defined locally
- In-process Kubernetes client (the API reconciles cluster state directly)

## Layout

```
src/
  modules/<feature>/   # feature-scoped: routes.ts, service.ts, *.test.ts (100+ modules)
  db/                  # Drizzle schema, migrations, seed
  cli/                 # one-shot CLI entrypoints sharing the module code
                       #   (pitr-job, pg-dump-job, dr-restore-runner; more on the roadmap)
  config/  shared/  test-helpers/
```

Feature work lives under `src/modules/<feature>/`. See `CLAUDE.md` and the
tenant-lifecycle / system-tenant sections for the cross-cutting runtimes.

## Commands

```bash
npm run dev          # tsx watch (hot reload) on :3000
npm run build        # tsc → dist/
npm run start        # run the built server
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test         # vitest (all)
npm run test:unit            # unit only
npm run test:integration     # integration (needs a DB)
npm run test:coverage        # coverage report
npm run db:generate  # drizzle-kit: generate a migration from schema changes
npm run db:migrate   # apply migrations
npm run db:seed      # seed baseline data
```

> Build [`@insula/api-contracts`](../packages/api-contracts) first (with
> `--force`) or typecheck will fail to resolve `@insula/api-contracts`.

## Conventions

- API prefix `/api/v1/`; envelope `{ data, pagination, error }`; error codes in
  `SCREAMING_SNAKE_CASE`. See `docs/04-deployment/API_ERROR_HANDLING.md`.
- Auth: JWT Bearer (`sub`, `role`, `exp`, `iat`).
- Pagination: cursor-based, `limit` ≤ 100 (`MAX_PAGE_LIMIT` from api-contracts).
- Target 80%+ coverage on new code; prefer TDD.

See the root [CONTRIBUTING.md](../CONTRIBUTING.md) for the full workflow.
