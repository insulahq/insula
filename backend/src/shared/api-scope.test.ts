import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { enforceApiScope, methodScope, requiredScope } from './api-scope.js';

function req(opts: {
  method?: string; url?: string; body?: unknown; headers?: Record<string, string>;
  config?: Record<string, unknown>; scopes?: string[] | null;
}): FastifyRequest {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/api/v1/x',
    body: opts.body,
    headers: opts.headers ?? {},
    routeOptions: { url: opts.url ?? '/api/v1/x', config: opts.config ?? {} },
    user: opts.scopes === null ? { sub: 'u', role: 'admin' } : {
      sub: 'u', role: 'admin',
      apiToken: { tokenId: 't', kind: 'pat', name: 'n', scopes: opts.scopes ?? ['read'], via: 'api' },
    },
  } as unknown as FastifyRequest;
}

describe('the scope a route needs', () => {
  it('follows the method by default', () => {
    expect(methodScope('GET')).toBe('read');
    expect(methodScope('HEAD')).toBe('read');
    expect(methodScope('POST')).toBe('write');
    expect(methodScope('PATCH')).toBe('write');
    expect(methodScope('DELETE')).toBe('delete');
  });

  it('treats a path naming an irreversible action as delete — for writes only', () => {
    expect(requiredScope('POST', '/api/v1/admin/nodes/:name/delete', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/tenants/:t/files/trash/purge', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/tenants/:t/deployments/:id/restore', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/tenants/:t/deployments/:id/import-from-file', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/tenants/:t/users/:u/reset-password', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/tenants/:t/deployments/:id/regenerate-credentials', undefined)).toBe('delete');
    // Plural path segments name the same action (code review: a write token
    // could run an admin restore cart because "restores" missed the word list).
    expect(requiredScope('POST', '/api/v1/admin/restores/carts/:id/execute', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/admin/tenants/:t/bundle-imports', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/admin/dr/tenants/recover-all', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/admin/tenants/:t/decommission', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/admin/stuck-deprovisions/:ns/force-clear', undefined)).toBe('delete');
    expect(requiredScope('POST', '/api/v1/admin/pods/prune', undefined)).toBe('delete');
    // Reading about a delete is a read.
    expect(requiredScope('GET', '/api/v1/tenants/:t/domains/:d/delete-preview', undefined)).toBe('read');
    // Words that merely contain the verb do not count.
    expect(requiredScope('POST', '/api/v1/tenants/:t/dropdown-options', undefined)).toBe('write');
  });

  it('lets a route state its scope, or decide it from the body', () => {
    expect(requiredScope('POST', '/api/v1/tenants/:t/files/trash/restore', 'write')).toBe('write');
    const permanent = (r: FastifyRequest) => ((r.body as { permanent?: boolean }).permanent ? 'delete' : 'write');
    expect(requiredScope('POST', '/x', permanent, req({ body: { permanent: true } }))).toBe('delete');
    expect(requiredScope('POST', '/x', permanent, req({ body: { permanent: false } }))).toBe('write');
    expect(requiredScope('POST', '/x', permanent, req({}), false)).toBe('pending');
  });
});

describe('enforcing it', () => {
  it('leaves session requests alone', () => {
    expect(() => enforceApiScope(req({ method: 'DELETE', scopes: null }))).not.toThrow();
  });

  it('refuses a token without the scope, with INSUFFICIENT_SCOPE', () => {
    expect(() => enforceApiScope(req({ method: 'POST', scopes: ['read'] }))).toThrow(/write/);
    expect(() => enforceApiScope(req({ method: 'POST', scopes: ['read', 'write'] }))).not.toThrow();
    expect(() => enforceApiScope(req({ method: 'DELETE', scopes: ['read', 'write'] }))).toThrow(/delete/);
  });

  it('refuses routes closed to tokens outright', () => {
    expect(() => enforceApiScope(req({ scopes: ['read', 'write', 'delete'], config: { apiTokenForbidden: 'no' } })))
      .toThrow('no');
  });

  it('judges a body rule at auth time only when no body is coming, and always at the handler', () => {
    const rule = (r: FastifyRequest) => ((r.body as { permanent?: boolean } | undefined)?.permanent ? 'delete' : 'write');
    const pending = req({ method: 'POST', scopes: ['read', 'write'], config: { apiScope: rule }, headers: { 'content-length': '20' } });
    expect(() => enforceApiScope(pending, 'auth')).not.toThrow();
    const parsed = req({ method: 'POST', scopes: ['read', 'write'], config: { apiScope: rule }, body: { permanent: true } });
    expect(() => enforceApiScope(parsed, 'handler')).toThrow(/delete/);
    // No body coming: decided at auth time, body treated as absent.
    const empty = req({ method: 'POST', scopes: ['read'], config: { apiScope: rule } });
    expect(() => enforceApiScope(empty, 'auth')).toThrow(/write/);
  });
});
