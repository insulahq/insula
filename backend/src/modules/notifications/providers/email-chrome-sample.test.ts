import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationTemplateResponse } from '@insula/api-contracts';
import { ALL_SEED_TEMPLATES } from '../templates/seed-data.js';

const getActiveTemplateMock = vi.fn();
vi.mock('../templates/service.js', () => ({ getActiveTemplate: getActiveTemplateMock }));

const { renderEmailChromePreviewSample, EMAIL_CHROME_SAMPLE_CATEGORY } = await import('./email-chrome-sample.js');

const db = {} as Parameters<typeof renderEmailChromePreviewSample>[0];

function seedTemplate(categoryId: string): NotificationTemplateResponse {
  const t = ALL_SEED_TEMPLATES.find((s) => s.categoryId === categoryId && s.channel === 'email');
  if (!t) throw new Error(`no email seed for ${categoryId}`);
  return {
    id: 'tpl-sample',
    categoryId: t.categoryId,
    channel: t.channel,
    locale: t.locale,
    subjectTemplate: t.subjectTemplate,
    bodyTemplate: t.bodyTemplate,
    bodyFormat: t.bodyFormat,
    variablesSchema: t.variablesSchema,
    version: 1,
    isActive: true,
    isSeed: true,
    editedByUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as NotificationTemplateResponse;
}

beforeEach(() => getActiveTemplateMock.mockReset());

describe('renderEmailChromePreviewSample', () => {
  it("renders the sample category's ACTIVE email template through the real renderer", async () => {
    getActiveTemplateMock.mockResolvedValue(seedTemplate(EMAIL_CHROME_SAMPLE_CATEGORY));
    const r = await renderEmailChromePreviewSample(db);
    expect(getActiveTemplateMock).toHaveBeenCalledWith(db, EMAIL_CHROME_SAMPLE_CATEGORY, 'email', 'en');
    expect(r.subject).toBe('Your password was changed');
    // Real MJML output: a full document the header/footer are inserted into.
    expect(r.html).toMatch(/<body[^>]*>/);
    expect(r.html).toContain('</body>');
    // Sample envelope values, not raw template tags.
    expect(r.html).toContain('Alex Mwangi');
    expect(r.html).not.toContain('{{');
  });

  it('still returns a document when the template is missing', async () => {
    getActiveTemplateMock.mockResolvedValue(null);
    const r = await renderEmailChromePreviewSample(db);
    expect(r.html).toMatch(/<body[^>]*>[\s\S]*Sample notification[\s\S]*<\/body>/);
  });
});
