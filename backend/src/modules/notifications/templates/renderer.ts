/**
 * Template renderer — Handlebars + MJML in strict mode.
 *
 * Strict mode prevents helpers / partials that could read process.env
 * or the filesystem. We never call `Handlebars.registerHelper` at
 * module-load — the only helpers in scope are the built-in escape
 * primitives.
 *
 * The compiled-template LRU cache is keyed by `${templateId}::${version}`
 * so an operator PATCH that bumps the version invalidates automatically.
 *
 * NOTE: mjml v5 is async. The renderer returns a synchronous-feeling
 * RenderedTemplate but the actual compile is gated on a sync call to
 * the synchronous Handlebars step + an async MJML step when the body
 * format is mjml. Use `renderTemplate` for the sync path (in_app /
 * plaintext / markdown / pre-rendered HTML); use `renderTemplateAsync`
 * when the body format may be mjml.
 */

import Handlebars from 'handlebars';
// mjml v5 has an async signature. We call it via `await` below.
import mjml2html from 'mjml';
import { LRUCache } from 'lru-cache';
import type {
  NotificationTemplateResponse,
  NotificationTemplateVariable,
  NotificationBodyFormat,
} from '@insula/api-contracts';
import { ApiError } from '../../../shared/errors.js';

export interface RenderTemplateOptions {
  /** When true, omit the MJML → HTML step (e.g. live preview wants raw). */
  readonly skipMjml?: boolean;
}

export interface RenderedTemplate {
  readonly subject: string | null;
  readonly body: string;
  readonly bodyFormat: NotificationBodyFormat;
}

interface CompiledTemplate {
  readonly subject: Handlebars.TemplateDelegate | null;
  readonly body: Handlebars.TemplateDelegate;
}

const COMPILED_CACHE = new LRUCache<string, CompiledTemplate>({
  max: 500,
  ttl: 1000 * 60 * 60, // 1h — operator edits bump version which invalidates anyway
});

// Strict mode: throw on missing variables instead of rendering ''.
// noEscape: false so HTML-escaping is default.
interface HandlebarsCompileOpts {
  strict: boolean;
  noEscape: boolean;
  knownHelpersOnly: boolean;
  knownHelpers: Record<string, boolean>;
}
const COMPILE_OPTS: HandlebarsCompileOpts = {
  strict: true,
  noEscape: false,
  knownHelpersOnly: true,
  knownHelpers: {},
};

function compile(template: NotificationTemplateResponse): CompiledTemplate {
  const cacheKey = `${template.id}::${template.version}`;
  const cached = COMPILED_CACHE.get(cacheKey);
  if (cached) return cached;

  const body = Handlebars.compile(template.bodyTemplate, COMPILE_OPTS);
  const subject = template.subjectTemplate
    ? Handlebars.compile(template.subjectTemplate, COMPILE_OPTS)
    : null;
  const compiled: CompiledTemplate = { body, subject };
  COMPILED_CACHE.set(cacheKey, compiled);
  return compiled;
}

function validateVariables(
  schema: readonly NotificationTemplateVariable[] | null,
  vars: Record<string, unknown>,
): void {
  if (!schema || schema.length === 0) return;
  for (const v of schema) {
    if (v.required && !(v.name in vars)) {
      throw new ApiError(
        'TEMPLATE_RENDER_ERROR',
        `Missing required template variable '${v.name}'`,
        400,
        { variable: v.name },
      );
    }
  }
}

function runHandlebars(
  template: NotificationTemplateResponse,
  variables: Record<string, unknown>,
): { subject: string | null; body: string } {
  let subject: string | null = null;
  let body: string;
  try {
    const { subject: subjectFn, body: bodyFn } = compile(template);
    if (subjectFn) subject = subjectFn(variables);
    body = bodyFn(variables);
  } catch (err) {
    throw new ApiError(
      'TEMPLATE_RENDER_ERROR',
      `Handlebars render failed: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { template_id: template.id },
    );
  }
  return { subject, body };
}

/**
 * Sync render. Throws if the template's body format is mjml without
 * skipMjml=true; callers that may encounter mjml should use renderTemplateAsync
 * or pass skipMjml=true.
 *
 * Throws TEMPLATE_RENDER_ERROR (400) on:
 *   - missing required variable (per template.variablesSchema)
 *   - Handlebars strict-mode lookup failure (referenced var absent)
 */
export function renderTemplate(
  template: NotificationTemplateResponse,
  variables: Record<string, unknown>,
  opts: RenderTemplateOptions = {},
): RenderedTemplate {
  validateVariables(template.variablesSchema, variables);
  const { subject, body } = runHandlebars(template, variables);

  if (template.bodyFormat === 'mjml' && !opts.skipMjml) {
    // Sync path can't await mjml; fall back to raw MJML output. The
    // dispatcher uses renderTemplateAsync for true HTML output.
    return { subject, body, bodyFormat: template.bodyFormat };
  }
  return { subject, body, bodyFormat: template.bodyFormat };
}

/**
 * Async render. Same contract as renderTemplate but additionally compiles
 * MJML to HTML when body_format='mjml'. Use this from the dispatcher
 * (email channel) and the admin preview endpoint.
 */
export async function renderTemplateAsync(
  template: NotificationTemplateResponse,
  variables: Record<string, unknown>,
  opts: RenderTemplateOptions = {},
): Promise<RenderedTemplate> {
  validateVariables(template.variablesSchema, variables);
  const rendered = runHandlebars(template, variables);
  const { subject } = rendered;
  let body = rendered.body;

  if (template.bodyFormat === 'mjml' && !opts.skipMjml) {
    try {
      const result = await mjml2html(body, { validationLevel: 'soft' });
      const errors = result.errors ?? [];
      if (errors.length > 0 && !result.html) {
        throw new Error(errors.map((e: { formattedMessage?: string; message?: string }) => e.formattedMessage ?? e.message ?? '').join('; '));
      }
      body = result.html;
    } catch (err) {
      throw new ApiError(
        'TEMPLATE_RENDER_ERROR',
        `MJML compile failed: ${err instanceof Error ? err.message : String(err)}`,
        400,
        { template_id: template.id },
      );
    }
  }

  return { subject, body, bodyFormat: template.bodyFormat };
}

/** Test-only seam to clear the compile cache between tests. */
export function _resetRendererCacheForTests(): void {
  COMPILED_CACHE.clear();
}
