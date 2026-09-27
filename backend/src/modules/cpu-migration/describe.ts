/**
 * ONE description of what the migration would do to a deployment (ADR-062).
 *
 * ★ Why this module exists.
 *
 * The dry run and the apply are supposed to be the same decision seen twice:
 * the operator reviews a plan, then authorises it. They were not. The preview
 * derived a deployment's tier from the CATALOG's `resources.recommended.cpu`
 * (and `high` for anything custom); the runner re-derived it from the
 * deployment's CURRENT `cpu_request`. Those disagree for any catalog app that
 * was ever resized, and for every custom deployment at the platform's own
 * `100m` default — where the preview says `high` (30m) and a
 * current-value derivation says `normal` (5m), the precise outcome the
 * preview's own comment warns against.
 *
 * Two code paths computing "the same" number is the defect. Sharing one
 * function is the fix; keeping them in step by discipline is not.
 */

import {
  type CpuMigrationBlocker, type CpuTier,
} from '@insula/api-contracts';
import { deriveTier, tierMillis, blockerFor } from './tiers.js';
import { customSpecPinsCpu, recommendedCores } from './preview.js';
import { cpuToMillis } from '../dashboard/cpu-reservation.js';

/** The columns every caller must select. Keep the SQL in step with this. */
export interface DeploymentFactsRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly cpu_request: string | null;
  readonly source: string | null;
  readonly source_repo_id: string | null;
  readonly custom_spec: unknown;
  readonly entry_resources: unknown;
}

export interface DescribedDeployment {
  readonly id: string;
  readonly name: string;
  readonly currentMillis: number;
  readonly proposedTier: CpuTier;
  readonly proposedMillis: number;
  readonly blocker: CpuMigrationBlocker | null;
  /** plan.ts skips these rather than overwriting an operator's number. */
  readonly pinsOwnCpu: boolean;
  readonly containerCount: number;
  readonly isComposeStack: boolean;
}

export function describeDeployment(
  row: DeploymentFactsRow,
  officialRepoId: string | null,
): DescribedDeployment {
  const declaresOwnResources = customSpecPinsCpu(row.custom_spec);
  const thirdPartyCatalog = row.source === 'catalog'
    && row.source_repo_id !== null
    && row.source_repo_id !== officialRepoId;

  const proposedTier: CpuTier = row.source === 'custom'
    // A custom container has no catalog recommendation to derive from.
    // `high` is the safe default: `normal` would quietly starve an app
    // nobody sized.
    ? 'high'
    : deriveTier(recommendedCores(row.entry_resources));

  const services = (row.custom_spec as { services?: unknown } | null)?.services;
  const serviceCount = Array.isArray(services)
    ? services.length
    : services && typeof services === 'object'
      ? Object.keys(services).length
      : 0;

  return {
    id: row.id,
    name: row.name,
    currentMillis: cpuToMillis(row.cpu_request ?? undefined),
    proposedTier,
    proposedMillis: tierMillis(proposedTier),
    blocker: blockerFor({
      source: row.source === 'custom' ? 'custom' : 'catalog',
      thirdPartyCatalog,
      declaresOwnResources,
    }),
    // The runner must not overwrite a pinned value, and must not treat a
    // compose stack's aggregate request as one container's.
    pinsOwnCpu: row.source === 'custom' && declaresOwnResources,
    containerCount: Math.max(1, serviceCount),
    isComposeStack: serviceCount > 1,
  };
}

/**
 * The SQL both callers use, so the shared function can never be fed a row the
 * other side did not select. `running` only: a stopped deployment holds no
 * reservation, so counting it would inflate the preview against the live pod
 * figures shown beside it.
 */
export const DEPLOYMENT_FACTS_COLUMNS = `
  d.id, d.name, d.tenant_id, d.cpu_request, d.source,
  d.custom_spec, e.resources AS entry_resources, e.source_repo_id
`;
