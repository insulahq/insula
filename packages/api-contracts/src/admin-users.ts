import { z } from 'zod';
import { paginatedResponseSchema } from './shared.js';

export const createAdminUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1).max(255),
  password: z.string().min(8).max(128),
  role_name: z.enum(['admin', 'support', 'billing', 'read_only']),
});

export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;

export const updateAdminUserSchema = z.object({
  full_name: z.string().min(1).max(255).optional(),
  role_name: z.enum(['admin', 'support', 'billing', 'read_only']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: z.string().min(8).max(128).optional(),
});

export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

export const adminUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  roleName: z.string(),
  status: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

// ─── Tenant-Users (cross-tenant admin list) ─────────────────────────────────
//
// Tenant-panel users (panel='tenant') and sub-users joined to their owning
// tenant. Returned by GET /admin/tenant-users for the admin Tenants → Users
// tab. Includes a `tenantName` projection so the UI can render the tenant
// column without a second fetch.
export const tenantUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  roleName: z.string(),
  status: z.string(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type TenantUserResponse = z.infer<typeof tenantUserResponseSchema>;

export const tenantUserListResponseSchema = paginatedResponseSchema(tenantUserResponseSchema);
export type TenantUserListResponse = z.infer<typeof tenantUserListResponseSchema>;
