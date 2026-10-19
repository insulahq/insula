/**
 * Plan & limits, as data: every per-tenant limit, what the plan gives, what
 * the tenant overrides it to, and — while editing — what changes, what the
 * PATCH sends for it, and what that change will do.
 *
 * Kept free of React so the rules that matter are tested on their own:
 *   • a limit back on the plan is sent as `null` (no override), never as the
 *     plan's number — or a later plan change would not reach it;
 *   • a Custom box left empty is no override (`null`), NOT 0: 0 is a real
 *     value for several limits (0 mailboxes = mail off, 0 sends = outbound off);
 *   • only limits that changed are sent, so saving one limit cannot rewrite
 *     another that someone else changed meanwhile.
 */
import type { Tenant } from '@/types/api';
import type { Plan } from '@/hooks/use-plans';

export type LimitId =
  | 'cpu' | 'tier' | 'burst' | 'memory' | 'storage' | 'bandwidth'
  | 'mailboxes' | 'mailboxSize' | 'sendsHour' | 'sendsDay' | 'subUsers' | 'customContainers' | 'price';

export type LimitGroup = 'Compute' | 'Storage and traffic' | 'Email' | 'Users and features' | 'Billing';

export type LimitKind = 'number' | 'tier' | 'bool';

export interface LimitRow {
  readonly id: LimitId;
  readonly group: LimitGroup;
  readonly label: string;
  readonly kind: LimitKind;
  readonly unit: string;
  readonly step: string;
  /** The PATCH /tenants/:id field this limit is written through. */
  readonly field: string;
  /** The tenant's own value; null = follows the plan. */
  readonly override: string | null;
  /** The plan's value; null when the plan does not set one. */
  readonly planValue: string | null;
  /** Said under the label, always. */
  readonly hint?: string;
}

export interface Draft {
  readonly mode: 'plan' | 'custom';
  readonly value: string;
}

export type Tone = 'ok' | 'warn' | 'bad';

export interface Change {
  readonly id: LimitId;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly effect: string;
  readonly tone: Tone;
  /** The server would refuse it, so the review cannot be saved as it is. */
  readonly refused: boolean;
}

export const TIER_LABEL: Record<string, string> = { normal: 'Normal, 1× share', high: 'High, 2× share', highest: 'Highest, 4× share' };

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * A numeric limit as one canonical string. The override columns are
 * numeric(p,2), so the API answers "20.00" for what was saved as 20 — read
 * raw, every untouched custom limit compared unequal to its own box and was
 * re-sent on the next save.
 */
const num = (v: unknown): string | null => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
};

export function buildLimitRows(tenant: Tenant, plan: Plan | undefined, currency: string): LimitRow[] {
  return [
    { id: 'cpu', group: 'Compute', label: 'CPU', kind: 'number', unit: 'cores', step: '0.25', field: 'cpu_limit_override', override: num(tenant.cpuLimitOverride), planValue: num(plan?.cpuLimit) },
    { id: 'tier', group: 'Compute', label: 'CPU tier', kind: 'tier', unit: '', step: '', field: 'cpu_tier_override', override: str(tenant.cpuTierOverride), planValue: str(plan?.cpuTier) },
    { id: 'burst', group: 'Compute', label: 'Burst ceiling', kind: 'number', unit: 'cores', step: '0.5', field: 'cpu_burst_cores_override', override: num(tenant.cpuBurstCoresOverride), planValue: num(plan?.cpuBurstCores) },
    { id: 'memory', group: 'Compute', label: 'Memory', kind: 'number', unit: 'GB', step: '0.5', field: 'memory_limit_override', override: num(tenant.memoryLimitOverride), planValue: num(plan?.memoryLimit) },
    { id: 'storage', group: 'Storage and traffic', label: 'Storage', kind: 'number', unit: 'GB', step: '1', field: 'storage_limit_override', override: num(tenant.storageLimitOverride), planValue: num(plan?.storageLimit), hint: 'Grows online. Shrinking takes a snapshot and restore, with downtime.' },
    { id: 'bandwidth', group: 'Storage and traffic', label: 'Bandwidth', kind: 'number', unit: 'GB / month', step: '1', field: 'bandwidth_limit_override', override: num(tenant.bandwidthLimitOverride), planValue: num(plan?.bandwidthGbLimit) },
    { id: 'mailboxes', group: 'Email', label: 'Mailboxes', kind: 'number', unit: '', step: '1', field: 'max_mailboxes_override', override: num(tenant.maxMailboxesOverride), planValue: num(plan?.maxMailboxes), hint: '0 disables email: no new mailbox, and email cannot be enabled on a new domain. Existing mailboxes keep working.' },
    { id: 'mailboxSize', group: 'Email', label: 'Mailbox size', kind: 'number', unit: 'MB', step: '1', field: 'max_mailbox_size_mb_override', override: num(tenant.maxMailboxSizeMbOverride), planValue: num(plan?.maxMailboxSizeMb) },
    { id: 'sendsHour', group: 'Email', label: 'Sends per hour', kind: 'number', unit: 'messages', step: '1', field: 'email_send_rate_limit', override: num(tenant.emailSendRateLimit), planValue: num(plan?.emailHourlySendLimit), hint: 'Per mail domain. 0 blocks all outbound mail.' },
    { id: 'sendsDay', group: 'Email', label: 'Sends per day', kind: 'number', unit: 'messages', step: '1', field: 'email_send_rate_limit_daily', override: num(tenant.emailSendRateLimitDaily), planValue: num(plan?.emailDailySendLimit), hint: 'Per mail domain, resets at 00:00 UTC. 0 blocks all outbound mail.' },
    { id: 'subUsers', group: 'Users and features', label: 'Sub-users', kind: 'number', unit: '', step: '1', field: 'max_sub_users_override', override: num(tenant.maxSubUsersOverride), planValue: num(plan?.maxSubUsers), hint: '0 prevents new sub-users. Existing sub-users keep their access.' },
    { id: 'customContainers', group: 'Users and features', label: 'Custom containers', kind: 'bool', unit: '', step: '', field: 'allow_custom_containers_override', override: str(tenant.allowCustomContainersOverride), planValue: str(plan?.allowCustomContainers ?? false) },
    { id: 'price', group: 'Billing', label: 'Monthly price', kind: 'number', unit: currency, step: '0.01', field: 'monthly_price_override', override: num(tenant.monthlyPriceOverride), planValue: num(plan?.monthlyPriceUsd) },
  ];
}

export function formatLimit(row: Pick<LimitRow, 'kind' | 'unit' | 'id'>, value: string | null): string {
  if (value === null) return '—';
  if (row.kind === 'tier') return TIER_LABEL[value] ?? value;
  if (row.kind === 'bool') return value === 'true' ? 'Allowed' : 'Not allowed';
  if (row.id === 'price') return `${row.unit} ${Number.isFinite(Number(value)) ? Number(value).toFixed(2) : value}`;
  if (row.unit === 'cores' && Number(value) === 1) return `${value} core`;
  return row.unit ? `${value} ${row.unit}` : value;
}

export function initialDraft(row: LimitRow): Draft {
  return row.override !== null
    ? { mode: 'custom', value: row.override }
    : { mode: 'plan', value: row.planValue ?? (row.kind === 'bool' ? 'false' : row.kind === 'tier' ? 'normal' : '') };
}

/**
 * The value a draft would send: null for "follow the plan" and for an empty
 * Custom box; a number, tier or boolean otherwise. `undefined` = not a valid
 * value (a number box holding something that is not a number).
 */
export function draftValue(row: LimitRow, draft: Draft): string | number | boolean | null | undefined {
  if (draft.mode === 'plan') return null;
  if (row.kind === 'bool') return draft.value === 'true';
  if (row.kind === 'tier') return ['normal', 'high', 'highest'].includes(draft.value) ? draft.value : null;
  const t = draft.value.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface EffectContext {
  /** Measured use, by limit — what a lower limit would cut under. */
  readonly inUse: Partial<Record<LimitId, number>>;
  readonly cpuTiered: boolean;
}

/** The limit as it would read after the change: the plan's when back on the plan or left empty. */
function resolved(row: LimitRow, sent: string | number | boolean | null): string | null {
  return sent === null ? row.planValue : String(sent);
}

export function effectOf(row: LimitRow, from: string | null, to: string | null, ctx: EffectContext): { effect: string; tone: Tone } {
  const n = to === null ? NaN : Number(to);
  const o = from === null ? NaN : Number(from);
  const used = ctx.inUse[row.id];
  switch (row.id) {
    case 'storage':
      if (used !== undefined && n < used) return { effect: `Below the ${used} GB in use: the shrink would be refused.`, tone: 'bad' };
      if (n < o) return { effect: 'Shrinks the volume: a snapshot, a new smaller volume and a restore. The tenant is offline for a few minutes per GB; you confirm it separately.', tone: 'bad' };
      if (n > o) return { effect: 'Grows the volume online, without downtime.', tone: 'ok' };
      return { effect: 'Takes effect on save.', tone: 'ok' };
    case 'tier':
    case 'burst':
      return ctx.cpuTiered
        ? { effect: 'Saved now; reaches the cluster with Re-apply under Cluster → CPU scheduling. A new burst ceiling replaces the pods one at a time.', tone: 'warn' }
        : { effect: 'Saved, but not in effect: this tenant still uses the legacy CPU limit until it is migrated under Cluster → CPU scheduling.', tone: 'warn' };
    case 'sendsHour':
    case 'sendsDay':
      if (n === 0) return { effect: '0 blocks all outbound mail from this tenant.', tone: 'bad' };
      return { effect: 'Sent to the mail server on save.', tone: 'ok' };
    case 'mailboxes':
      if (n === 0) return { effect: '0 disables email for this tenant: no new mailbox, and email cannot be enabled on a new domain. Existing mailboxes keep working.', tone: 'warn' };
      if (used !== undefined && n < used) return { effect: `Below the ${used} mailboxes in use. They keep working; no new ones can be added.`, tone: 'warn' };
      return { effect: 'Takes effect on save.', tone: 'ok' };
    case 'subUsers':
      if (n === 0) return { effect: '0 prevents this tenant from creating any sub-user. Existing sub-users keep their access.', tone: 'warn' };
      if (used !== undefined && n < used) return { effect: `Below the ${used} sub-users in use. They keep access; no new ones can be added.`, tone: 'warn' };
      return { effect: 'Takes effect on save.', tone: 'ok' };
    case 'bandwidth':
      if (used !== undefined && n < used) return { effect: `Below the ${used} GB already used this cycle: the tenant is capped at once.`, tone: 'warn' };
      return { effect: 'Takes effect on save.', tone: 'ok' };
    default:
      return { effect: 'Takes effect on save.', tone: 'ok' };
  }
}

export interface DraftDiff {
  readonly changes: readonly Change[];
  /** The PATCH body: only the changed limits. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  /** Labels of limits whose box holds something that is not a valid value. */
  readonly invalid: readonly string[];
}

export function diffDrafts(rows: readonly LimitRow[], drafts: Readonly<Partial<Record<LimitId, Draft>>>, ctx: EffectContext): DraftDiff {
  const changes: Change[] = [];
  const payload: Record<string, string | number | boolean | null> = {};
  const invalid: string[] = [];
  for (const row of rows) {
    const draft = drafts[row.id];
    if (!draft) continue;
    const sent = draftValue(row, draft);
    if (sent === undefined) {
      invalid.push(row.label);
      continue;
    }
    const before = row.override;
    const after = sent === null ? null : String(sent);
    if (before === after) continue;
    if (row.kind === 'number' && before !== null && after !== null && Number(before) === Number(after)) continue;
    payload[row.field] = sent;
    const fromShown = before === null ? `${formatLimit(row, row.planValue)} (plan)` : formatLimit(row, before);
    const toShown = after === null ? `${formatLimit(row, row.planValue)} (plan)` : formatLimit(row, after);
    const { effect, tone } = effectOf(row, resolved(row, before === null ? null : before), resolved(row, sent), ctx);
    const refused = row.id === 'storage' && tone === 'bad' && ctx.inUse.storage !== undefined && Number(resolved(row, sent)) < ctx.inUse.storage;
    changes.push({ id: row.id, label: row.label, from: fromShown, to: toShown, effect, tone, refused });
  }
  return { changes, payload, invalid };
}

/** A change the server would refuse, so the review cannot be saved as it is. */
export function isRefused(c: Change): boolean {
  return c.refused;
}
