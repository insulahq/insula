import { describe, it, expect } from 'vitest';
import { createTenantSchema, updateTenantSchema } from './schema.js';

describe('createTenantSchema', () => {
  const validInput = {
    name: 'Acme Corp',
    contact_name: 'Jane Doe',
    primary_email: 'admin@acme.com',
    phone_e164: '+14155552671',
    billing_address: {
      street_address: '123 Main St',
      postal_address: 'PO Box 1',
      city: 'San Francisco',
      country: 'US',
    },
    plan_id: '550e8400-e29b-41d4-a716-446655440000',
    region_id: '550e8400-e29b-41d4-a716-446655440001',
  };

  it('should accept valid input', () => {
    const result = createTenantSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should reject missing name', () => {
    const { name, ...rest } = validInput;
    const result = createTenantSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject invalid email', () => {
    const result = createTenantSchema.safeParse({ ...validInput, primary_email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID plan_id', () => {
    const result = createTenantSchema.safeParse({ ...validInput, plan_id: 'not-uuid' });
    expect(result.success).toBe(false);
  });

  it('should accept optional secondary_email', () => {
    const result = createTenantSchema.safeParse({ ...validInput, secondary_email: 'contact@acme.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secondary_email).toBe('contact@acme.com');
    }
  });

  it('should accept optional subscription_expires_at', () => {
    const result = createTenantSchema.safeParse({
      ...validInput,
      subscription_expires_at: '2026-12-31T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateTenantSchema', () => {
  it('should accept empty object (no updates)', () => {
    const result = updateTenantSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept partial updates', () => {
    const result = updateTenantSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('should validate status enum', () => {
    expect(updateTenantSchema.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ status: 'archived' }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
    expect(updateTenantSchema.safeParse({ status: 'invalid' }).success).toBe(false);
  });

  // The mailbox override used to be min(1), so an operator disabling mail
  // for one tenant got a validation error with no alternative short of
  // suspending the whole tenant. 0 is the way to say "no mailboxes".
  it('accepts max_mailboxes_override = 0 (mail off for this tenant)', () => {
    expect(updateTenantSchema.safeParse({ max_mailboxes_override: 0 }).success).toBe(true);
  });

  it('still rejects a negative max_mailboxes_override', () => {
    expect(updateTenantSchema.safeParse({ max_mailboxes_override: -1 }).success).toBe(false);
  });

  it('keeps null meaning "inherit the plan" for max_mailboxes_override', () => {
    expect(updateTenantSchema.safeParse({ max_mailboxes_override: null }).success).toBe(true);
  });

  // Same asymmetry, same fix: hosting_plans.max_sub_users has always
  // allowed 0 while the per-tenant override did not.
  it('accepts max_sub_users_override = 0 and rejects negatives', () => {
    expect(updateTenantSchema.safeParse({ max_sub_users_override: 0 }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ max_sub_users_override: -1 }).success).toBe(false);
  });

  // The per-mailbox SIZE cap is deliberately NOT part of this change: a
  // 0 MB mailbox is meaningless, and its floor is 50 MB.
  it('still rejects max_mailbox_size_mb_override = 0', () => {
    expect(updateTenantSchema.safeParse({ max_mailbox_size_mb_override: 0 }).success).toBe(false);
  });
});
