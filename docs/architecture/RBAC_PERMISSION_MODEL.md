# RBAC & Permission Model

## Overview

The platform uses a role-based access control (RBAC) model with **panel-level enforcement** and **client-scoped access**. Two separate frontends (admin panel, tenant panel) serve different user populations, and the backend enforces which panel each user can access via JWT claims.

## Role Hierarchy

### Admin Panel Roles (Staff)

| Role | Access Level | Can Impersonate | Manage Platform |
|------|-------------|-----------------|-----------------|
| `super_admin` | Full platform access, OIDC config, user management | Yes | Yes |
| `admin` | Manage clients, domains, workloads, all resources | Yes | No |
| `billing` | Subscriptions, invoices, plan changes | No | No |
| `support` | Read clients + assist (domains, databases, backups) | Yes | No |
| `read_only` | Dashboard, metrics, status only | No | No |

### Tenant Panel Roles (Customers)

| Role | Access Level | Manage Sub-Users |
|------|-------------|------------------|
| `tenant_admin` | Full access to own client account | Yes |
| `tenant_user` | View-only access to own client resources | No |

## JWT Claims

```typescript
// Admin panel JWT
{
  sub: string,           // User ID
  role: string,          // super_admin | admin | billing | support | read_only
  panel: "admin",        // Panel enforcement
  exp: number,
  iat: number,
  jti: string            // Unique token ID for denylist
}

// Tenant panel JWT
{
  sub: string,           // User ID
  role: string,          // tenant_admin | tenant_user
  panel: "client",       // Panel enforcement
  tenantId: string,      // Which client account this user belongs to
  exp: number,
  iat: number,
  jti: string
}

// Impersonation JWT (admin acting as client)
{
  sub: string,           // Client user ID (not admin's ID)
  role: "tenant_admin",
  panel: "client",
  tenantId: string,
  impersonatedBy: string, // Admin user ID (for audit trail)
  exp: number,           // Short expiry (1 hour)
  iat: number,
  jti: string
}
```

## Panel Enforcement

| Rule | How |
|------|-----|
| Client users can't access admin panel | `requirePanel('admin')` middleware on all admin routes |
| Admin users can't directly login to tenant panel | Login endpoint checks `user.panel` — admin users rejected |
| Client users must match a client account | On login, match `user.email` against `clients.companyEmail` or `clients.contactEmail` — no match = rejected |

## Client User Auto-Creation

When a client account is created via the admin panel:
1. A `tenant_admin` user is automatically created with `companyEmail`
2. A strong password (20 chars, mixed case + digits + symbols) is generated
3. The password is returned **once** in the API response — never stored in plaintext
4. The user's `tenantId` is set to the new client's ID
5. The user's `panel` is set to `'client'`

## Sub-User Management

- Client admins can create sub-users from the tenant panel
- Sub-users get role `tenant_user` (view-only)
- Maximum sub-users is controlled by the hosting plan's `max_sub_users` field
- Sub-users inherit the parent's `tenantId`

## Impersonation

**Who can impersonate:** `super_admin`, `admin`, `support`

**Flow:**
1. Admin clicks "Login as Client" on the ClientDetail page
2. Backend `POST /api/v1/admin/impersonate/:tenantId`:
   - Verifies caller has impersonation permission
   - Finds the `tenant_admin` user for that client
   - Issues a tenant-panel JWT with `impersonatedBy` claim
   - JWT has 1-hour expiry (shorter than normal 24h)
3. Frontend opens tenant panel in a new tab with the token
4. All actions during impersonation are logged with `impersonatedBy` in the audit trail

## Database Schema

### Users Table (updated)

| Column | Type | Description |
|--------|------|-------------|
| `panel` | `'admin' \| 'client'` | Which panel this user belongs to |
| `tenant_id` | `varchar(36)` nullable | FK to clients — set for client users |

### Hosting Plans Table (updated)

| Column | Type | Description |
|--------|------|-------------|
| `max_sub_users` | `int` default 3 | Maximum sub-users per client on this plan |

### RBAC Roles (seeded)

| Role Name | Permissions | Panel |
|-----------|-------------|-------|
| `super_admin` | `["*"]` | admin |
| `admin` | `["clients:*","domains:*","databases:*","workloads:*","backups:*","cron-jobs:*","subscriptions:*"]` | admin |
| `billing` | `["clients:read","subscriptions:*","billing:*"]` | admin |
| `support` | `["clients:read","domains:*","databases:*","backups:*","impersonate"]` | admin |
| `read_only` | `["clients:read","metrics:read","status:read"]` | admin |
| `tenant_admin` | `["own:*"]` | client |
| `tenant_user` | `["own:read"]` | client |

## Middleware Stack

```
Request → authenticate → requirePanel → requireRole → requireClientAccess → handler
```

- `authenticate`: Validates JWT, checks denylist
- `requirePanel('admin' | 'client')`: Checks `panel` claim
- `requireRole(...roles)`: Checks `role` claim against allowed list
- `requireClientAccess()`: For client-scoped routes, verifies `tenantId` in JWT matches `:tenantId` URL param
