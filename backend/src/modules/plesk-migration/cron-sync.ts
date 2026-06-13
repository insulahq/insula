/**
 * Plesk migration — scheduled-task (cron) leg (R1).
 *
 * Plesk runs a subscription's scheduled tasks from the system user's crontab.
 * The discovery captured those lines (base64 over the TSV transport) into
 * `snapshot.cronLines`. This leg parses each line and recreates it as a
 * platform cron job — purely a set of DB inserts (`createCronJob`), no Job/k8s.
 *
 * Mapping (Plesk → platform), conservative by design:
 *   - A plain `curl`/`wget` of an http(s) URL (no shell composition) →
 *     a **webcron** (type=webcron, url, method), ENABLED — these map cleanly
 *     since they just hit a URL.
 *   - Anything else (a shell command) → a **deployment** cron bound to the
 *     subscription's web deployment, imported **DISABLED**: the command's
 *     paths/binaries refer to the Plesk vhost layout, not the new container,
 *     so the operator reviews + fixes + enables it (we never silently run a
 *     command that would fail or do the wrong thing).
 *   - `@reboot`, named schedule fields (MON/JAN), env-assignment lines, and
 *     malformed lines are reported as `skipped` with a reason.
 *
 * Standard `@`-macros are translated to 5-field expressions (the platform's
 * cron validator is numeric-only).
 */

import { eq, and, like, asc } from 'drizzle-orm';
import { deployments as deploymentsTable } from '../../db/schema.js';
import { createCronJob } from '../cron-jobs/service.js';
import { webDeploymentName } from './content-sync.js';
import { createCronJobSchema } from '@insula/api-contracts';
import type { CreateCronJobInput, PleskSubscription } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { LegItem, MigrationLogger } from './provision.js';

// Platform cron schedule field: numeric/star/list/range/step only (mirrors the
// api-contracts cronRegex — named months/days are NOT accepted).
const CRON_FIELD = /^[0-9*,\-/]+$/;

// Standard crontab macros → numeric 5-field equivalents. `@reboot` has no
// periodic equivalent and is intentionally absent (→ skipped).
const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

type ParsedCron = { schedule: string; command: string };

/** Parse one crontab line into a numeric 5-field schedule + command, or a skip reason. */
export function parseCrontabLine(raw: string): ParsedCron | { skip: string } {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return { skip: 'comment or blank line' };
  // crontab env assignment (MAILTO=, PATH=, FOO=bar) — not a job.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
    return { skip: `environment line (${line.split('=')[0].trim()}) — set it on the deployment instead` };
  }
  const tokens = line.split(/\s+/);
  if (tokens[0].startsWith('@')) {
    const macro = MACROS[tokens[0].toLowerCase()];
    if (!macro) return { skip: `unsupported schedule '${tokens[0]}' (e.g. @reboot has no periodic equivalent)` };
    const command = tokens.slice(1).join(' ');
    return command ? { schedule: macro, command } : { skip: 'no command after schedule' };
  }
  if (tokens.length < 6) return { skip: 'malformed line — expected 5 schedule fields + a command' };
  const fields = tokens.slice(0, 5);
  if (!fields.every((f) => CRON_FIELD.test(f))) {
    return { skip: 'named/aliased schedule fields (e.g. MON, JAN, @reboot) are unsupported — re-create this task manually' };
  }
  const command = tokens.slice(5).join(' ');
  return command ? { schedule: fields.join(' '), command } : { skip: 'no command after schedule' };
}

export type ClassifiedCommand =
  | { type: 'webcron'; url: string; httpMethod: 'GET' | 'POST' | 'PUT' }
  | { type: 'deployment' };

// A command we won't treat as a simple URL fetch if it contains shell
// composition — it does more than hit a URL, so run it verbatim.
const SHELL_COMPOSITION = /[;`\n><]|\|\||&&|\$\(|\|/;

/**
 * Classify a crontab command: a bare `curl`/`wget` of an http(s) URL becomes a
 * webcron; everything else is a deployment command run verbatim.
 */
export function classifyCommand(command: string): ClassifiedCommand {
  const trimmed = command.trim();
  const isFetcher = /^(\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/)?(curl|wget|lynx|fetch|GET)\b/.test(trimmed);
  if (!isFetcher || SHELL_COMPOSITION.test(trimmed)) return { type: 'deployment' };
  const m = trimmed.match(/https?:\/\/[^\s'"]+/);
  if (!m) return { type: 'deployment' };
  const url = m[0].replace(/['"]+$/, '');
  try {
    new URL(url);
  } catch {
    return { type: 'deployment' };
  }
  let httpMethod: 'GET' | 'POST' | 'PUT' = 'GET';
  if (/(^|\s)(-X|--request)\s+POST\b/i.test(trimmed) || /(^|\s)(--data|--data-\S+|--post-data|--post-file)\b/.test(trimmed)) {
    httpMethod = 'POST';
  } else if (/(^|\s)(-X|--request)\s+PUT\b/i.test(trimmed)) {
    httpMethod = 'PUT';
  }
  return { type: 'webcron', url, httpMethod };
}

function snippet(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A human label for the per-item leg row. */
export function cronLabel(index: number, raw: string): string {
  const s = snippet(raw, 60);
  return `cron ${index + 1}${s ? `: ${s}` : ''}`;
}

function cronName(index: number, kind: 'webcron' | 'deployment', detail: string): string {
  const prefix = kind === 'webcron' ? 'Webcron' : 'Cron';
  const name = `${prefix}: ${snippet(detail, 80)}`.slice(0, 255);
  return name.length > prefix.length + 2 ? name : `Migrated cron ${index + 1}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The subscription's web deployment to attach command crons to (main domain's, else any). */
async function resolveWebDeploymentId(db: Database, tenantId: string, snapshot: PleskSubscription): Promise<string | null> {
  const mainName = webDeploymentName(snapshot.name);
  const [main] = await db
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(and(eq(deploymentsTable.tenantId, tenantId), eq(deploymentsTable.name, mainName)))
    .limit(1);
  if (main) return main.id;
  const [anyWeb] = await db
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(and(eq(deploymentsTable.tenantId, tenantId), like(deploymentsTable.name, 'web-%')))
    .orderBy(asc(deploymentsTable.createdAt))
    .limit(1);
  return anyWeb?.id ?? null;
}

export async function runCronLeg(
  db: Database,
  tenantId: string,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  const lines = snapshot.cronLines ?? [];
  if (lines.length === 0) return [];

  // Resolved lazily: only command crons need it, and resolving once is enough.
  let deploymentId: string | null = null;
  let deploymentResolved = false;

  const items: LegItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const label = cronLabel(i, lines[i]);
    const parsed = parseCrontabLine(lines[i]);
    if ('skip' in parsed) {
      items.push({ name: label, status: 'skipped', message: parsed.skip });
      continue;
    }
    const classified = classifyCommand(parsed.command);
    try {
      let input: CreateCronJobInput;
      if (classified.type === 'webcron') {
        input = createCronJobSchema.parse({
          name: cronName(i, 'webcron', classified.url),
          type: 'webcron',
          schedule: parsed.schedule,
          url: classified.url,
          http_method: classified.httpMethod,
          enabled: true,
        });
      } else {
        if (!deploymentResolved) {
          deploymentId = await resolveWebDeploymentId(db, tenantId, snapshot);
          deploymentResolved = true;
        }
        if (!deploymentId) {
          items.push({ name: label, status: 'skipped', message: 'no web deployment to run the command in — deploy the app, then re-create this task' });
          continue;
        }
        input = createCronJobSchema.parse({
          name: cronName(i, 'deployment', parsed.command),
          type: 'deployment',
          schedule: parsed.schedule,
          command: parsed.command,
          deployment_id: deploymentId,
          // Imported disabled: the command references the Plesk layout, not the
          // new container — the operator reviews + enables it.
          enabled: false,
        });
      }
      await createCronJob(db, tenantId, input);
      const message = classified.type === 'webcron'
        ? `webcron → ${classified.httpMethod} ${classified.url} (enabled)`
        : 'imported DISABLED — review the command/paths for the new container, then enable';
      items.push({ name: label, status: 'completed', message });
    } catch (err) {
      logger.warn({ err, tenantId, line: lines[i] }, 'plesk migration: cron import failed');
      items.push({ name: label, status: 'failed', message: `could not import: ${errMsg(err)}` });
    }
  }
  return items;
}
