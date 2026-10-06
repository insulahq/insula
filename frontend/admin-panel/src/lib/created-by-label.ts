/**
 * Tenant detail → Account Information → "Created By", as a person.
 *
 * The API resolves `createdBy` (a user id) to `createdByName` — the user's full
 * name, or their email when the name is blank. When it resolves to nobody, the
 * id says why: unset or `system` means a platform process created the tenant
 * (bootstrap, DR re-create); any other id is a user that no longer exists.
 */
export const SYSTEM_CREATOR_ID = 'system';

export function createdByLabel(
  createdBy: string | null | undefined,
  createdByName: string | null | undefined,
): string {
  const name = createdByName?.trim();
  if (name) return name;
  if (!createdBy || createdBy === SYSTEM_CREATOR_ID) return 'System';
  return 'Unknown';
}
