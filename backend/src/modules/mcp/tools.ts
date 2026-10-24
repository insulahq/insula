/**
 * MCP tools — every one of them a view of an operation in the catalog.
 *
 * Three generic tools reach the WHOLE API: `find_operations` to search it,
 * `describe_operation` for an operation's inputs, `call_operation` to run it.
 * The core tools below are named shortcuts for the functions agents use most;
 * each names one catalog operation (by its route) and takes its input schema
 * from that route. There is no tool logic of its own to drift from the
 * platform: rename or remove a route and `tools.test.ts` fails.
 *
 * The tenant MCP endpoint offers its own, smaller set: the tenant panel's
 * functions, with the tenant id filled in from the connection (an agent there
 * acts inside ONE tenant and never names it), and a search that leaves out
 * admin-only operations. What an agent can actually do is still decided by
 * each route's own guards — the lists only decide what it is shown.
 */
import type { McpAudience, McpScope } from '@insula/api-contracts';
import type { Operation, OperationCatalog } from './catalog.js';
import { normalizeKey } from './catalog.js';

export interface CoreTool {
  readonly name: string;
  readonly description: string;
  /** "METHOD /path" of the route it runs. */
  readonly operation: string;
  /** Body fields the tool sets itself (and hides from the agent). */
  readonly fixedBody?: Record<string, unknown>;
  /** Query fields the tool sets itself. */
  readonly fixedQuery?: Record<string, unknown>;
}

const TENANT_FILES = 'Paths are relative to the tenant\'s files root.';

export const CORE_TOOLS: readonly CoreTool[] = [
  // ── tenants ──────────────────────────────────────────────────────────────
  { name: 'list_tenants', operation: 'GET /tenants', description: 'List tenants (search, status filter, cursor pagination).' },
  { name: 'get_tenant', operation: 'GET /tenants/:id', description: 'One tenant: status, plan, placement, resource limits, contact details.' },
  { name: 'create_tenant', operation: 'POST /tenants', description: 'Create a new tenant (provisions its namespace, storage and admin user).' },
  { name: 'update_tenant', operation: 'PATCH /tenants/:id', description: 'Change a tenant\'s details, limits or status. Archiving needs the delete scope.' },
  { name: 'suspend_tenant', operation: 'PATCH /tenants/:id', fixedBody: { status: 'suspended' }, description: 'Suspend a tenant: workloads scaled to 0, sites show the suspended page, mail and cron paused. Reversible with reactivate_tenant.' },
  { name: 'reactivate_tenant', operation: 'PATCH /tenants/:id', fixedBody: { status: 'active' }, description: 'Reactivate a suspended tenant.' },
  { name: 'delete_tenant', operation: 'DELETE /tenants/:id', description: 'Permanently delete a tenant and everything it owns. Irreversible (delete scope).' },
  { name: 'get_tenant_subscription', operation: 'GET /tenants/:id/subscription', description: 'A tenant\'s subscription: plan and expiry.' },
  { name: 'update_tenant_subscription', operation: 'PATCH /tenants/:id/subscription', description: 'Change a tenant\'s subscription plan or expiry.' },
  { name: 'list_plans', operation: 'GET /plans', description: 'Hosting (subscription) plans.' },
  { name: 'get_tenant_placement', operation: 'GET /tenants/:id/placement', description: 'Which node a tenant runs on and where its data lives.' },
  { name: 'list_tenant_users', operation: 'GET /tenants/:tenantId/users', description: 'A tenant\'s panel users.' },
  // ── tenant files ─────────────────────────────────────────────────────────
  { name: 'list_tenant_files', operation: 'GET /tenants/:tenantId/files', description: `List a directory of a tenant's files. ${TENANT_FILES}` },
  { name: 'read_tenant_file', operation: 'GET /tenants/:tenantId/files/read', description: `Read a text file of a tenant. ${TENANT_FILES}` },
  { name: 'write_tenant_file', operation: 'POST /tenants/:tenantId/files/write', description: `Create or overwrite a text file of a tenant. ${TENANT_FILES}` },
  { name: 'create_tenant_directory', operation: 'POST /tenants/:tenantId/files/mkdir', description: `Create a directory. ${TENANT_FILES}` },
  { name: 'rename_tenant_file', operation: 'POST /tenants/:tenantId/files/rename', description: `Rename or move a file or directory. ${TENANT_FILES}` },
  { name: 'move_tenant_file_to_trash', operation: 'POST /tenants/:tenantId/files/delete', fixedBody: { permanent: false }, description: `Move a file or directory to the tenant's recycle bin (recoverable; write scope). ${TENANT_FILES}` },
  { name: 'delete_tenant_file_permanently', operation: 'POST /tenants/:tenantId/files/delete', fixedBody: { permanent: true }, description: `Delete a file or directory for good, bypassing the recycle bin (delete scope). ${TENANT_FILES}` },
  { name: 'list_tenant_trash', operation: 'GET /tenants/:tenantId/files/trash', description: 'The tenant\'s recycle bin.' },
  { name: 'restore_tenant_trash_entry', operation: 'POST /tenants/:tenantId/files/trash/restore', description: 'Put a recycle-bin entry back where it was.' },
  // ── deployments ──────────────────────────────────────────────────────────
  { name: 'list_tenant_deployments', operation: 'GET /tenants/:tenantId/deployments', description: 'A tenant\'s applications and their status.' },
  { name: 'get_deployment', operation: 'GET /tenants/:tenantId/deployments/:id', description: 'One deployment in detail.' },
  { name: 'restart_deployment', operation: 'POST /tenants/:tenantId/deployments/:id/restart', description: 'Restart a deployment\'s pods.' },
  { name: 'get_deployment_logs', operation: 'GET /tenants/:tenantId/deployments/:id/logs', description: 'Recent container logs of a deployment.' },
  // ── domains ──────────────────────────────────────────────────────────────
  { name: 'list_tenant_domains', operation: 'GET /tenants/:tenantId/domains', description: 'A tenant\'s domains.' },
  { name: 'add_tenant_domain', operation: 'POST /tenants/:tenantId/domains', description: 'Add a domain to a tenant.' },
  // ── platform ─────────────────────────────────────────────────────────────
  { name: 'list_nodes', operation: 'GET /admin/nodes', description: 'Cluster nodes with roles, status and usage.' },
  { name: 'list_audit_logs', operation: 'GET /admin/audit-logs', description: 'The audit log — who did what, including actions taken through API tokens.' },
  { name: 'get_traffic', operation: 'GET /admin/monitoring/traffic/series', description: 'Traffic over time: cluster, node, tenant (subject = namespace), pod or route.' },
];

const MY_FILES = 'Paths are relative to your files root.';

/** The tenant MCP endpoint's core tools — tenant-panel functions of the agent's own tenant. */
export const TENANT_CORE_TOOLS: readonly CoreTool[] = [
  // ── files ────────────────────────────────────────────────────────────────
  { name: 'list_files', operation: 'GET /tenants/:tenantId/files', description: `List a directory of your files. ${MY_FILES}` },
  { name: 'read_file', operation: 'GET /tenants/:tenantId/files/read', description: `Read a text file. ${MY_FILES}` },
  { name: 'write_file', operation: 'POST /tenants/:tenantId/files/write', description: `Create or overwrite a text file. ${MY_FILES}` },
  { name: 'create_directory', operation: 'POST /tenants/:tenantId/files/mkdir', description: `Create a directory. ${MY_FILES}` },
  { name: 'rename_file', operation: 'POST /tenants/:tenantId/files/rename', description: `Rename or move a file or directory. ${MY_FILES}` },
  { name: 'move_file_to_trash', operation: 'POST /tenants/:tenantId/files/delete', fixedBody: { permanent: false }, description: `Move a file or directory to the recycle bin (recoverable; write scope). ${MY_FILES}` },
  { name: 'delete_file_permanently', operation: 'POST /tenants/:tenantId/files/delete', fixedBody: { permanent: true }, description: `Delete a file or directory for good, bypassing the recycle bin (delete scope). ${MY_FILES}` },
  { name: 'list_trash', operation: 'GET /tenants/:tenantId/files/trash', description: 'The recycle bin.' },
  { name: 'restore_trash_entry', operation: 'POST /tenants/:tenantId/files/trash/restore', description: 'Put a recycle-bin entry back where it was.' },
  // ── applications ─────────────────────────────────────────────────────────
  { name: 'list_deployments', operation: 'GET /tenants/:tenantId/deployments', description: 'Your applications and their status.' },
  { name: 'get_deployment', operation: 'GET /tenants/:tenantId/deployments/:id', description: 'One application in detail.' },
  { name: 'restart_deployment', operation: 'POST /tenants/:tenantId/deployments/:id/restart', description: 'Restart an application\'s pods.' },
  { name: 'get_deployment_logs', operation: 'GET /tenants/:tenantId/deployments/:id/logs', description: 'Recent container logs of an application.' },
  // ── domains & mail ───────────────────────────────────────────────────────
  { name: 'list_domains', operation: 'GET /tenants/:tenantId/domains', description: 'Your domains.' },
  { name: 'list_dns_records', operation: 'GET /tenants/:tenantId/domains/:domainId/dns-records', description: 'DNS records of one of your domains.' },
  { name: 'list_email_aliases', operation: 'GET /tenants/:tenantId/email/aliases', description: 'Your email aliases (forwarders).' },
  // ── cron & usage ─────────────────────────────────────────────────────────
  { name: 'list_cron_jobs', operation: 'GET /tenants/:id/cron-jobs', description: 'Your scheduled jobs.' },
  { name: 'run_cron_job', operation: 'POST /tenants/:id/cron-jobs/:cronJobId/run', description: 'Run a scheduled job now.' },
  { name: 'get_resource_usage', operation: 'GET /tenants/:tenantId/resource-usage', description: 'CPU, memory and storage use against your plan\'s limits.' },
];

export function coreToolsFor(audience: McpAudience): readonly CoreTool[] {
  return audience === 'tenant' ? TENANT_CORE_TOOLS : CORE_TOOLS;
}

/**
 * The path parameter that names the tenant (`/tenants/:tenantId/…` or
 * `/tenants/:id/…`), which a tenant agent never supplies itself.
 */
export function tenantParamOf(op: Pick<Operation, 'path'>): string | null {
  return op.path.match(/^\/tenants\/:([A-Za-z0-9_]+)(\/|$)/)?.[1] ?? null;
}

const TENANT_ROLES = new Set(['tenant_admin', 'tenant_user']);

/**
 * Whether a tenant agent is shown an operation: not admin-panel-only, not
 * platform-wide, and not one that issues a credential (refused to it anyway).
 */
export function tenantVisible(op: Operation): boolean {
  if (op.path.startsWith('/admin/') || op.path.startsWith('/internal/') || op.panel === 'admin') return false;
  if (op.issuesCredential) return false;
  if (op.allowedRoles && !op.allowedRoles.some((r) => TENANT_ROLES.has(r))) return false;
  return true;
}

/** The scope a core tool needs, as far as can be known before the call. */
function scopeOf(tool: CoreTool, op: Operation): McpScope | 'varies' {
  if (op.scope !== 'varies') return op.scope;
  if (tool.fixedBody && op.scopeRule && typeof op.scopeRule === 'function') {
    // Same rule the route applies, against the body the tool always sends.
    return op.scopeRule({ body: tool.fixedBody } as never);
  }
  return 'varies';
}

function withoutFields(schema: Record<string, unknown> | null, fields: readonly string[]): Record<string, unknown> {
  if (!schema) return { type: 'object', additionalProperties: true };
  const props = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const f of fields) delete props[f];
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((r) => !fields.includes(r))
    : undefined;
  return { ...schema, properties: props, ...(required ? { required } : {}) };
}

/**
 * JSON schema of a tool's arguments: path params, `query`, `body`, and for the
 * admin endpoint `asTenant`. A tenant agent's tenant id is filled in for it.
 */
export function inputSchemaFor(op: Operation, tool?: CoreTool, audience: McpAudience = 'admin'): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const auto = audience === 'tenant' ? tenantParamOf(op) : null;
  const pathParams = op.pathParams.filter((p) => p !== auto);
  for (const p of pathParams) properties[p] = { type: 'string', description: `Path parameter "${p}".` };
  const fixedQuery = Object.keys(tool?.fixedQuery ?? {});
  const fixedBody = Object.keys(tool?.fixedBody ?? {});
  if (op.querySchema || op.method === 'GET') properties.query = { ...withoutFields(op.querySchema, fixedQuery), description: 'Query-string parameters.' };
  if (op.method !== 'GET' && op.method !== 'DELETE') properties.body = { ...withoutFields(op.bodySchema, fixedBody), description: 'JSON request body.' };
  if (op.method === 'DELETE') properties.query = { type: 'object', additionalProperties: true, description: 'Query-string parameters.' };
  if (audience === 'admin') {
    properties.asTenant = {
      type: 'string',
      description: 'Tenant id: act as that tenant\'s admin user (impersonation, audited). Needed for tenant-panel-only operations.',
    };
  }
  return { type: 'object', properties, required: pathParams, additionalProperties: false };
}

export interface ResolvedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly operation: Operation;
  readonly tool: CoreTool;
  readonly scope: McpScope | 'varies';
}

/**
 * The core tools whose routes exist in this build. A tool whose route is
 * missing is skipped (and reported) instead of failing every other tool —
 * `tools.test.ts` is what stops that from shipping.
 */
export function resolveCoreTools(
  catalog: OperationCatalog, warn: (msg: string) => void = () => {}, audience: McpAudience = 'admin',
): ResolvedTool[] {
  const out: ResolvedTool[] = [];
  for (const tool of coreToolsFor(audience)) {
    const op = catalog.get(normalizeKey(tool.operation));
    if (!op || op.excluded) {
      warn(`[mcp] core tool ${tool.name}: route ${tool.operation} ${op ? `excluded (${op.excluded})` : 'not found'} — skipped`);
      continue;
    }
    const scope = scopeOf(tool, op);
    out.push({
      name: tool.name,
      description: `${tool.description} [scope: ${scope}] (${op.key})`,
      inputSchema: inputSchemaFor(op, tool, audience),
      operation: op,
      tool,
      scope,
    });
  }
  return out;
}

/** Search the catalog the way an agent would ask: words, any order. */
export function searchOperations(
  catalog: OperationCatalog, query: string, limit: number, audience: McpAudience = 'admin',
): Operation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ops = catalog.callable().filter((op) => audience === 'admin' || tenantVisible(op));
  if (words.length === 0) return ops.slice(0, limit);
  const scored = ops.map((op) => {
    const hay = `${op.key} ${op.summary ?? ''} ${op.description ?? ''} ${op.tags.join(' ')}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    return { op, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.op.key.localeCompare(b.op.key));
  return scored.slice(0, limit).map((x) => x.op);
}

/** What an agent sees of an operation. */
export function describeOperation(op: Operation): Record<string, unknown> {
  return {
    operation: op.key,
    summary: op.summary,
    description: op.description,
    scope: op.scope,
    allowedRoles: op.allowedRoles,
    tenantPanelOnly: op.panel === 'tenant',
    pathParams: op.pathParams,
    querySchema: op.querySchema,
    bodySchema: op.bodySchema,
    excluded: op.excluded,
  };
}
