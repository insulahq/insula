import { describe, it, expect } from 'vitest';
import { createTenantSchema, updateTenantSchema } from './schema.js';

describe('createTenantSchema', () => {
  const validInput = {
    name: 'Acme Corp',
    primary_email: 'admin@acme.com',
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
});
