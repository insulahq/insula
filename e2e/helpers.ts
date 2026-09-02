import { Page, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Backend API isn't publicly exposed — calls go through the admin-panel
// nginx sidecar which reverse-proxies /api/* to platform-api internally.
// Dev stack serves HTTPS-only on :2011 (see playwright.config.ts).
//
// All helper HTTP goes through Playwright's APIRequestContext, NOT node's
// global fetch: the request context honours ignoreHTTPSErrors (no
// NODE_TLS_REJECT_UNAUTHORIZED export needed for the local CA), and the
// worker-process global fetch was observed mangling chunked responses
// from the dev ingress into unparseable JSON (2026-08-24).
const API_BASE = process.env.API_URL ?? 'https://admin.insula.host:2011';

let _apiCtx: APIRequestContext | null = null;
async function apiCtx(): Promise<APIRequestContext> {
  if (!_apiCtx) {
    _apiCtx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  }
  return _apiCtx;
}

async function apiGet(url: string, headers?: Record<string, string>): Promise<unknown> {
  const ctx = await apiCtx();
  return (await ctx.get(url, { headers })).json();
}

async function apiPost(url: string, data: unknown, headers?: Record<string, string>): Promise<unknown> {
  const ctx = await apiCtx();
  return (await ctx.post(url, { data, headers })).json();
}

export async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('email-input').fill('admin@insula.host');
  await page.getByTestId('password-input').fill('admin');
  await page.getByTestId('login-button').click();

  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 5000 });
}

export async function injectAdminAuth(page: Page) {
  const authPath = path.join(__dirname, '.auth/admin-auth.json');
  if (!fs.existsSync(authPath)) {
    // Fallback to full login if setup hasn't run
    await loginAsAdmin(page);
    return;
  }

  const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  await page.goto('/login');
  await page.evaluate((data) => {
    if (data.token) localStorage.setItem('auth_token', data.token);
    if (data.user) localStorage.setItem('auth_user', data.user);
  }, authData);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({ timeout: 5000 });
}

/**
 * Get or create a test tenant and return impersonation credentials.
 * Uses the admin API to create a tenant, then impersonates it.
 * Caches the result to e2e/.auth/tenant-auth.json for reuse across tests.
 */
async function getTenantAuth(): Promise<{ token: string; user: string }> {
  const cachePath = path.join(__dirname, '.auth/tenant-auth.json');
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (cached.token && cached.user) return cached;
  }

  // Get admin token
  const adminAuthPath = path.join(__dirname, '.auth/admin-auth.json');
  let adminToken: string;

  if (fs.existsSync(adminAuthPath)) {
    const adminAuth = JSON.parse(fs.readFileSync(adminAuthPath, 'utf-8'));
    adminToken = adminAuth.token;
  } else {
    // Login as admin to get token
    const loginData = await apiPost(`${API_BASE}/api/v1/auth/login`, {
      email: 'admin@insula.host',
      password: 'admin',
    }) as { data: { token: string } };
    adminToken = loginData.data.token;
  }

  const headers = {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  // Check if test tenant already exists
  // The wire field is `primaryEmail` (renamed from the legacy `companyEmail`
  // — matching either keeps this helper working across both shapes).
  const tenantsData = await apiGet(`${API_BASE}/api/v1/tenants?limit=100`, headers) as { data: { id: string; primaryEmail?: string; companyEmail?: string }[] };
  let tenantId = tenantsData.data?.find((c) => (c.primaryEmail ?? c.companyEmail) === 'e2e-test@insula.host')?.id;

  // Create test tenant if not exists
  if (!tenantId) {
    // Get first available plan and region
    const [plansData, regionsData] = await Promise.all([
      apiGet(`${API_BASE}/api/v1/plans`, headers) as Promise<{ data: { id: string }[] }>,
      apiGet(`${API_BASE}/api/v1/regions`, headers) as Promise<{ data: { id: string }[] }>,
    ]);
    const planId = plansData.data?.[0]?.id;
    const regionId = regionsData.data?.[0]?.id;

    const createData = await apiPost(`${API_BASE}/api/v1/tenants`, {
      name: 'E2E Test Tenant',
      primary_email: 'e2e-test@insula.host',
      plan_id: planId,
      region_id: regionId,
    }, headers) as { data: { id: string } };
    if (createData.data?.id) {
      tenantId = createData.data.id;
    } else {
      // Race condition: another worker created the tenant — retry search
      await new Promise(r => setTimeout(r, 1000));
      const retryData = await apiGet(`${API_BASE}/api/v1/tenants?limit=100`, headers) as { data: { id: string; primaryEmail?: string; companyEmail?: string }[] };
      tenantId = retryData.data?.find((c) => (c.primaryEmail ?? c.companyEmail) === 'e2e-test@insula.host')?.id;
      if (!tenantId) {
        throw new Error(`Failed to create or find test tenant: ${JSON.stringify(createData)}`);
      }
    }
  }

  // Impersonate the tenant to get a tenant-panel JWT. Tenant creation is
  // async — the tenant_admin user is provisioned shortly after the tenant
  // row, so impersonation can race and return NO_TENANT_USER. Retry for
  // up to 10s, which comfortably covers the worker's post-create hook.
  let impersonateData: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    impersonateData = await apiPost(`${API_BASE}/api/v1/admin/impersonate/${tenantId}`, {}, {
      'Authorization': headers['Authorization'],
    }) as Record<string, unknown>;
    if (impersonateData.data && (impersonateData.data as Record<string, unknown>).token) break;
    // Only retry the specific "no tenant_admin yet" error — surface others
    const err = impersonateData.error as { code?: string } | undefined;
    if (err?.code !== 'NO_TENANT_USER') break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!impersonateData.data || !(impersonateData.data as Record<string, unknown>).token) {
    throw new Error(`Failed to impersonate tenant ${tenantId}: ${JSON.stringify(impersonateData)}`);
  }

  const impData = impersonateData.data as { token: string; user: Record<string, unknown> };
  const result = {
    token: impData.token,
    user: JSON.stringify(impData.user),
  };

  // Cache for reuse
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result));

  return result;
}

/**
 * Login to the tenant panel by injecting an impersonation token.
 * Creates a test tenant on first call and caches credentials.
 */
export async function loginAsAdminTenant(page: Page) {
  const auth = await getTenantAuth();

  await page.goto('/login');
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('auth_user', data.user);
  }, auth);
  await page.goto('/');

  await expect(page.getByTestId('welcome-heading')).toBeVisible({ timeout: 5000 });
}

/**
 * Ensure the shared E2E tenant is active and has at least one enabled
 * email domain; returns { tenantId, domainName } for specs that drive
 * the Email page. Idempotent — safe from any spec's beforeAll.
 */
export async function ensureSharedEmailDomain(): Promise<{ tenantId: string; domainName: string }> {
  let token: string | undefined;
  const adminAuthPath = path.join(__dirname, '.auth/admin-auth.json');
  if (fs.existsSync(adminAuthPath)) {
    token = (JSON.parse(fs.readFileSync(adminAuthPath, 'utf-8')) as { token?: string }).token;
  }
  if (!token) {
    const loginData = await apiPost(`${API_BASE}/api/v1/auth/login`, {
      email: 'admin@insula.host',
      password: 'admin',
    }) as { data: { token: string } };
    token = loginData.data.token;
  }
  const headers = { Authorization: `Bearer ${token}` };

  const tenants = await apiGet(`${API_BASE}/api/v1/tenants?limit=100`, headers) as {
    data: { id: string; primaryEmail?: string; companyEmail?: string }[];
  };
  let tenantId = tenants.data.find(
    (t) => (t.primaryEmail ?? t.companyEmail) === 'e2e-test@insula.host',
  )?.id;
  if (!tenantId) {
    const [plans, regions] = await Promise.all([
      apiGet(`${API_BASE}/api/v1/plans`, headers) as Promise<{ data: { id: string }[] }>,
      apiGet(`${API_BASE}/api/v1/regions`, headers) as Promise<{ data: { id: string }[] }>,
    ]);
    const created = await apiPost(`${API_BASE}/api/v1/tenants`, {
      name: 'E2E Test Tenant',
      primary_email: 'e2e-test@insula.host',
      plan_id: plans.data[0]?.id,
      region_id: regions.data[0]?.id,
    }, headers) as { data?: { id: string } };
    tenantId = created.data?.id;
  }
  if (!tenantId) throw new Error('shared E2E tenant missing and could not be created');

  // Domain/email ops need an ACTIVE tenant (created pending, no auto-provision).
  const status = async () =>
    ((await apiGet(`${API_BASE}/api/v1/tenants/${tenantId}`, headers) as { data?: { status?: string } }).data?.status ?? '');
  if ((await status()) !== 'active') {
    await apiPost(`${API_BASE}/api/v1/admin/tenants/${tenantId}/provision`, {}, headers);
    for (let i = 0; i < 45 && (await status()) !== 'active'; i++) {
      await new Promise((r) => setTimeout(r, 4000));
    }
    if ((await status()) !== 'active') throw new Error('shared E2E tenant did not reach active');
  }

  // Sweep leftovers from earlier interrupted spec runs — the shared
  // tenant's plan caps total mailboxes, so orphans starve creates.
  const ctxSweep = await apiCtx();
  const boxes = await apiGet(`${API_BASE}/api/v1/tenants/${tenantId}/mailboxes`, headers) as {
    data?: { id: string; localPart: string }[];
  };
  for (const mb of boxes.data ?? []) {
    if (/^(no-reply|fwd-ui)-/.test(mb.localPart)) {
      await ctxSweep.delete(`${API_BASE}/api/v1/tenants/${tenantId}/mailboxes/${mb.id}`, { headers });
    }
  }
  const aliasesList = await apiGet(`${API_BASE}/api/v1/tenants/${tenantId}/email/aliases`, headers) as {
    data?: { id: string; sourceAddress: string }[];
  };
  for (const al of aliasesList.data ?? []) {
    if (/^(team|loop)-/.test(al.sourceAddress)) {
      await ctxSweep.delete(`${API_BASE}/api/v1/tenants/${tenantId}/email/aliases/${al.id}`, { headers });
    }
  }

  const eds = await apiGet(`${API_BASE}/api/v1/tenants/${tenantId}/email/domains`, headers) as {
    data?: { id: string; domainName?: string; enabled: number }[];
  };
  const enabled = (eds.data ?? []).find((d) => d.enabled === 1);
  if (enabled?.domainName) return { tenantId, domainName: enabled.domainName };
  if (enabled) {
    // Older payloads may lack domainName — resolve via the domains list.
    const doms = await apiGet(`${API_BASE}/api/v1/tenants/${tenantId}/domains`, headers) as {
      data?: { id: string; domainName: string }[];
    };
    const any = (doms.data ?? [])[0];
    if (any) return { tenantId, domainName: any.domainName };
  }

  const stamp = Date.now().toString(36);
  const domainName = `e2eshared${stamp}.com`;
  const dom = await apiPost(`${API_BASE}/api/v1/tenants/${tenantId}/domains`, {
    domain_name: domainName,
    dns_mode: 'cname',
  }, headers) as { data?: { id: string } };
  if (!dom.data?.id) throw new Error('shared domain create failed');
  const enable = await apiPost(`${API_BASE}/api/v1/tenants/${tenantId}/email/domains/${dom.data.id}/enable`, {}, headers) as { data?: { id: string } };
  if (!enable.data?.id) throw new Error('shared email enable failed');
  return { tenantId, domainName };
}
