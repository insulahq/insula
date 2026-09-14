/**
 * The delivery-path renderer. It never throws.
 *
 * Two renderers, two contracts, on purpose:
 *
 *   renderTemplate / renderTemplateAsync  — STRICT. Used by the admin
 *     preview and the template editor, where a missing variable is an
 *     operator error and the right answer is a loud, specific message.
 *
 *   renderForDelivery (this module)       — LENIENT. Used by the
 *     dispatcher and the queue worker, where a missing variable must never
 *     be the reason a person is not told something.
 *
 * The failure mode of a notification system must not be silence. Before
 * this existed, one mismatched variable name marked sixteen renewal emails
 * `skipped` — not `failed`, not `dlq`, so no alert fired and no retry ran,
 * and the only trace was a `last_error` column nobody queries.
 *
 * Degrading is not the same as hiding: every absent variable is returned in
 * `degradedVars`, persisted on the delivery row, and counted in a metric,
 * so a thin notification is a reportable defect. See
 * `scripts/ci-notification-variable-contract.sh` for the check that stops
 * these reaching production in the first place.
 */
import { renderTemplateAsync } from './renderer.js';
import { fillMissingVariables, MISSING_VALUE } from './variables.js';
import type { NotificationTemplateResponse, NotificationBodyFormat } from '@insula/api-contracts';

export interface DeliveryRender {
  readonly subject: string | null;
  readonly body: string;
  readonly bodyFormat: NotificationBodyFormat;
  /** Referenced-but-unsupplied variables. Empty is the healthy case. */
  readonly degradedVars: readonly string[];
  /** True when the template itself could not render and the envelope was used. */
  readonly fallbackUsed: boolean;
  /** Renderer error behind `fallbackUsed`, for the delivery row. */
  readonly fallbackReason?: string;
}

export interface RenderForDeliveryOptions {
  readonly skipMjml?: boolean;
  /** Human-readable category name, used as the fallback subject. */
  readonly fallbackTitle?: string;
}

/**
 * Envelope fields, in the order a reader needs them: who, what, what
 * happened, when, what now. Anything outside this list is appended
 * afterwards so no supplied fact is dropped from the fallback.
 */
const ENVELOPE_ORDER: readonly string[] = [
  'tenantName',
  'contactName',
  'subsystem',
  'objectType',
  'objectLabel',
  'value',
  'threshold',
  'reason',
  'occurredAt',
  'actionText',
  'actionUrl',
];

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Last-resort body: the supplied facts as plain `Label: value` lines.
 *
 * Deliberately built from the variables rather than the template — the
 * template is what just failed. A message naming the tenant and the object
 * is worth far more than no message, which is what the caller got before.
 */
export function buildEnvelopeFallback(
  variables: Record<string, unknown>,
  title: string,
): string {
  const seen = new Set<string>(['platformName', 'userName']);
  const lines: string[] = [];

  for (const key of ENVELOPE_ORDER) {
    const v = scalar(variables[key]);
    seen.add(key);
    if (v && v !== MISSING_VALUE) lines.push(`${humanise(key)}: ${v}`);
  }
  for (const [key, raw] of Object.entries(variables)) {
    if (seen.has(key)) continue;
    const v = scalar(raw);
    if (v && v !== MISSING_VALUE) lines.push(`${humanise(key)}: ${v}`);
  }

  if (lines.length === 0) return title;
  return `${title}\n\n${lines.join('\n')}`;
}

/**
 * Render for delivery. Never throws — a caller in the delivery path has no
 * useful way to handle a render failure other than not telling anyone,
 * which is the outcome this exists to prevent.
 */
export async function renderForDelivery(
  template: NotificationTemplateResponse,
  variables: Record<string, unknown>,
  opts: RenderForDeliveryOptions = {},
): Promise<DeliveryRender> {
  const { variables: filled, degradedVars } = fillMissingVariables(template, variables);

  try {
    const rendered = await renderTemplateAsync(template, filled, { skipMjml: opts.skipMjml });
    return {
      subject: rendered.subject,
      body: rendered.body,
      bodyFormat: rendered.bodyFormat,
      degradedVars,
      fallbackUsed: false,
    };
  } catch (err) {
    // Strict mode still guards anything the reference extractor failed to
    // see, and MJML can fail on an operator-edited body. Neither may cost
    // the recipient the message.
    const title = opts.fallbackTitle ?? template.subjectTemplate ?? 'Notification';
    const safeTitle = title.includes('{{') ? (opts.fallbackTitle ?? 'Notification') : title;
    return {
      subject: safeTitle,
      body: buildEnvelopeFallback(filled, safeTitle),
      bodyFormat: 'plaintext',
      degradedVars,
      fallbackUsed: true,
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }
}
