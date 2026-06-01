# @insula/api-contracts

The **single source of truth** for every Insula API type. All request/response
shapes are defined here once as **Zod** schemas; the backend validates with
them and the panels derive their TypeScript types with `z.infer`. Nothing
downstream re-declares an API type.

## Why it exists

One definition, validated at runtime (backend) and checked at compile time
(frontend), keeps the API contract from drifting between server and clients.

```ts
// packages/api-contracts/src/tenants.ts
export const createTenantSchema = z.object({ name: z.string().min(1), /* … */ });
export type CreateTenant = z.infer<typeof createTenantSchema>;
```

```ts
// backend: validate with the schema       // frontend: use the inferred type
import { createTenantSchema } from '@insula/api-contracts';
import type { CreateTenant } from '@insula/api-contracts';
```

`src/` holds one file per domain (`auth`, `tenants`, `domains`, `databases`,
`backups`, …); `index.ts` re-exports everything. `shared.ts` holds the response
envelope and `MAX_PAGE_LIMIT` (pagination `limit` ≤ 100).

## Build — use `--force`

This package uses TypeScript **project references**. A plain `tsc --build`
honours a stale `tsbuildinfo` and can emit **zero files**, after which the
backend and panels fail to resolve `@insula/api-contracts`. Always force it:

```bash
# both commands run from the REPO ROOT (not from this package dir):
npm run build -w @insula/api-contracts -- --force
# inside a git worktree where npm's circular bin symlink breaks (exit 216):
node node_modules/typescript/bin/tsc -b packages/api-contracts --force
```

Rebuild after any schema change, before typechecking the backend or panels.

## Adding or changing a contract

1. Edit/add the schema in the relevant `src/*.ts` and export the `z.infer` type.
2. Re-export from `index.ts` if it's a new file.
3. Rebuild with `--force`.
4. Update the backend route + the frontend caller; typecheck both.

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md).
