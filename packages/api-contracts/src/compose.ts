// Compose-editor specific schemas — sit alongside custom-deployments.ts.
//
// The actual normalized form persisted in DB is `customDeploymentSpec`
// (see custom-deployments.ts). This file covers only the editor's
// transient input + output surfaces:
//   - `composeYamlSubmitSchema` is the request body for /validate
//     (also accepted by the create endpoint when mode='compose')
//   - `parseResultSchema` is the response from /validate
//   - `composeSchemaResponseSchema` is the JSON-schema document
//     served at GET /custom-deployments/compose-schema (consumed by
//     monaco-yaml in the tenant panel)

import { z } from 'zod';
import { validateCustomDeploymentResultSchema } from './custom-deployments.js';

// ─── /validate request ──────────────────────────────────────────────────────

/** Body posted to `POST /tenants/:cid/custom-deployments/validate`
 *  when the user is in the compose editor. Mirror of the compose
 *  fields on `createCustomDeploymentComposeSchema` but without `name`
 *  (validate can be called before naming). */
export const composeValidateRequestSchema = z.object({
  compose_yaml: z.string().min(1).max(256 * 1024),
  env_files: z.record(z.string().min(1).max(255), z.string().max(64 * 1024)).optional(),
});

// ─── /validate response ─────────────────────────────────────────────────────

/** Alias of `validateCustomDeploymentResultSchema` — same shape on
 *  purpose, exposed under a compose-flavoured name for the editor
 *  consumer. Single source of truth: a change to the validate-result
 *  contract propagates to both alias-holders automatically. */
export const composeParseResultSchema = validateCustomDeploymentResultSchema;

// ─── Compose JSON-Schema endpoint ───────────────────────────────────────────

/** Served at GET /custom-deployments/compose-schema; consumed by
 *  monaco-yaml in the tenant panel for inline schema-aware completion
 *  and red-squiggle on rejected fields. JSON Schema draft-07 shape
 *  (the format monaco-yaml expects). */
export const composeSchemaResponseSchema = z.object({
  $schema: z.string(),
  title: z.string(),
  /** Strictly typed as `unknown` — JSON Schema is recursive and big
   *  enough that mirroring its structure in Zod is not worth the cost.
   *  Consumers (only monaco-yaml at present) treat it as JSON Schema. */
  schema: z.record(z.string(), z.unknown()),
  /** Free-form server-version string for cache busting. */
  version: z.string(),
});

// ─── Inferred types ─────────────────────────────────────────────────────────

export type ComposeValidateRequest = z.infer<typeof composeValidateRequestSchema>;
export type ComposeParseResult = z.infer<typeof composeParseResultSchema>;
export type ComposeSchemaResponse = z.infer<typeof composeSchemaResponseSchema>;
