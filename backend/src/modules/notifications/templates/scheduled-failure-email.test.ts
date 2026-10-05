import { describe, it, expect } from 'vitest';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import { renderForDelivery } from './render-for-delivery.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

/**
 * The cron failure email is also sent to a job's failure contacts — people who
 * may have no platform account and will never open the panel. It therefore has
 * to carry the whole story itself: which task, whose account, when it runs,
 * why it failed, when, and where to fix it. And it has to say why the reader
 * is getting it, because the address was typed in by somebody else.
 */
function emailTemplate(): NotificationTemplateResponse {
  const t = ALL_SEED_TEMPLATES.find(
    (x) => x.categoryId === 'tasks.scheduled_failure' && x.channel === 'email' && x.locale === 'en',
  );
  if (!t) throw new Error('no email template for tasks.scheduled_failure');
  return { ...t, id: 'test-scheduled-failure-email', version: 1, isActive: true } as unknown as NotificationTemplateResponse;
}

const VARS = {
  platformName: 'Insula',
  userName: 'ops',
  greeting: null,
  tenantName: 'Example Ltd',
  contactName: null,
  occurredAt: '2026-10-05 12:00 UTC',
  actionButtons: '<mj-button href="https://tenant.example.test/cron-jobs">Open Cron Jobs</mj-button>',
  actionUrl: 'https://tenant.example.test/cron-jobs',
  actionText: 'Open Cron Jobs',
  tenantLink: null,
  taskName: 'Nightly import',
  schedule: '0 3 * * * (Europe/Berlin)',
  errorMessage: 'HTTP 500: upstream exploded',
};

describe('tasks.scheduled_failure email', () => {
  it('names the task and the account in the subject', async () => {
    const r = await renderForDelivery(emailTemplate(), VARS, { skipMjml: true });
    expect(r.subject).toBe('Scheduled task failed: Nightly import (Example Ltd)');
  });

  it('carries task, account, schedule, reason, time and the link to fix it', async () => {
    const r = await renderForDelivery(emailTemplate(), VARS, { skipMjml: true });
    expect(r.fallbackUsed).toBe(false);
    expect(r.degradedVars).toEqual([]);
    for (const fact of [
      'Nightly import',
      'Example Ltd',
      '0 3 * * * (Europe/Berlin)',
      'HTTP 500: upstream exploded',
      '2026-10-05 12:00 UTC',
      'https://tenant.example.test/cron-jobs',
    ]) {
      expect(r.body).toContain(fact);
    }
    // Why the reader is getting it, and that it will not flood them.
    expect(r.body).toMatch(/at most one email about it per day/);
  });

  it('escapes what the tenant typed — a job name is not markup', async () => {
    const r = await renderForDelivery(
      emailTemplate(),
      { ...VARS, taskName: '<a href="https://phish.example.test">click</a>' },
      { skipMjml: true },
    );
    expect(r.body).not.toContain('<a href="https://phish.example.test">');
    expect(r.body).toContain('&lt;a href');
  });

  it('still renders, without empty labels, for an emitter that predates the schedule', async () => {
    const r = await renderForDelivery(emailTemplate(), { ...VARS, schedule: null }, { skipMjml: true });
    expect(r.fallbackUsed).toBe(false);
    expect(r.body).not.toContain('Schedule:');
    expect(r.body).toContain('HTTP 500');
  });

  it('compiles to HTML through MJML', async () => {
    const r = await renderForDelivery(emailTemplate(), VARS);
    expect(r.fallbackUsed).toBe(false);
    expect(r.body).toContain('<html');
    expect(r.body).toContain('0 3 * * * (Europe/Berlin)');
  });
});
