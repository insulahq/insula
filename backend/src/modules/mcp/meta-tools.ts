/**
 * The three generic MCP tools that reach a whole panel's API — find, describe,
 * call — as each endpoint presents them. The admin endpoint's call_operation
 * takes `asTenant`; the tenant endpoint's fills in the agent's own tenant and
 * never takes one. Kept apart from server.ts so the endpoint file registers
 * routes and nothing else.
 */
/** The tenant endpoint's generic tools: the same three, without `asTenant` and admin wording. */
export const TENANT_META_TOOLS = [
  {
    name: 'find_operations',
    description: 'Search every operation of the tenant panel\'s API. Returns operation names ("METHOD /path"), '
      + 'what they do, and the scope each needs. Use describe_operation for inputs, call_operation to run one. '
      + 'Your tenant id is filled in for you.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "mailbox create" or "cron run".' },
        limit: { type: 'number', description: 'Maximum results (default 25, max 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'describe_operation',
    description: 'Inputs of one operation: path parameters, query and body JSON schemas, required scope.',
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string', description: 'e.g. "GET /tenants/:tenantId/domains".' } },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_operation',
    description: 'Run an operation of the tenant panel\'s API as you (your role applies). Needs the scope the '
      + 'operation requires (read: GET; write: changes; delete: anything irreversible). Leave the tenant id out: '
      + 'it is always your own tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'e.g. "POST /tenants/:tenantId/files/mkdir".' },
        pathParams: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        query: { type: 'object', additionalProperties: true },
        body: { description: 'JSON request body.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
] as const;

export const META_TOOLS = [
  {
    name: 'find_operations',
    description: 'Search every operation of the platform API (any function the admin panel has). '
      + 'Returns operation names ("METHOD /path"), what they do, and the scope each needs. '
      + 'Use describe_operation for inputs, call_operation to run one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "mailbox create" or "backup restore".' },
        limit: { type: 'number', description: 'Maximum results (default 25, max 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'describe_operation',
    description: 'Inputs of one operation: path parameters, query and body JSON schemas, required scope and roles.',
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string', description: 'e.g. "GET /tenants/:id".' } },
      required: ['operation'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_operation',
    description: 'Run any operation of the platform API. Needs the scope the operation requires '
      + '(read: GET; write: changes; delete: anything irreversible). Set asTenant to act as a tenant '
      + '(impersonation, audited) — required for tenant-panel-only operations.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'e.g. "PATCH /admin/plans/:id".' },
        pathParams: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        query: { type: 'object', additionalProperties: true },
        body: { description: 'JSON request body.' },
        asTenant: { type: 'string', description: 'Tenant id to act as.' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
  },
] as const;
