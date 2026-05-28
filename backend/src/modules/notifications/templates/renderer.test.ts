import { describe, it, expect, beforeEach } from 'vitest';
import { renderTemplate, renderTemplateAsync, _resetRendererCacheForTests } from './renderer.js';
import type { NotificationTemplateResponse } from '@k8s-hosting/api-contracts';
import { ApiError } from '../../../shared/errors.js';

function tpl(overrides: Partial<NotificationTemplateResponse> = {}): NotificationTemplateResponse {
  return {
    id: overrides.id ?? 'tpl-1',
    categoryId: 'security.password_changed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Hi {{userName}}',
    bodyTemplate: 'Hello {{userName}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'userName', type: 'string', required: true },
    ],
    isActive: true,
    isSeed: true,
    version: 1,
    editedByUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => _resetRendererCacheForTests());

describe('renderTemplate — plaintext path', () => {
  it('renders subject and body with provided variables', () => {
    const r = renderTemplate(tpl(), { userName: 'Alice' });
    expect(r.subject).toBe('Hi Alice');
    expect(r.body).toBe('Hello Alice');
    expect(r.bodyFormat).toBe('plaintext');
  });

  it('throws TEMPLATE_RENDER_ERROR when a required var is missing', () => {
    expect(() => renderTemplate(tpl(), {})).toThrow(ApiError);
    expect(() => renderTemplate(tpl(), {})).toThrow(/Missing required template variable/);
  });

  it('html-escapes user-controlled vars by default', () => {
    const r = renderTemplate(
      tpl({ bodyTemplate: 'Hello {{userName}}' }),
      { userName: '<script>alert(1)</script>' },
    );
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
  });

  it('falls back to no subject when template has none', () => {
    const r = renderTemplate(tpl({ subjectTemplate: null }), { userName: 'Bob' });
    expect(r.subject).toBeNull();
  });

  it('does not validate schema-less templates against vars', () => {
    const r = renderTemplate(tpl({ variablesSchema: null }), { userName: 'Bob' });
    expect(r.body).toBe('Hello Bob');
  });
});

describe('renderTemplateAsync — MJML path', () => {
  it('compiles MJML to HTML', async () => {
    const t = tpl({
      id: 'tpl-mjml',
      bodyFormat: 'mjml',
      bodyTemplate: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{userName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
    });
    const r = await renderTemplateAsync(t, { userName: 'Alice' });
    expect(r.bodyFormat).toBe('mjml');
    expect(r.body).toContain('<html');
    expect(r.body).toContain('Hello Alice');
  });

  it('skips MJML compile when opts.skipMjml is true', async () => {
    const t = tpl({
      id: 'tpl-mjml-skip',
      bodyFormat: 'mjml',
      bodyTemplate: '<mjml><mj-body><mj-text>Hi {{userName}}</mj-text></mj-body></mjml>',
    });
    const r = await renderTemplateAsync(t, { userName: 'Bob' }, { skipMjml: true });
    expect(r.body).toContain('<mjml>');
  });

  it('throws TEMPLATE_RENDER_ERROR on Handlebars-strict missing-var lookup', () => {
    // strict-mode kicks in for vars that are referenced but absent from the
    // variablesSchema — i.e. the renderer relies on hbs strict, not on
    // schema validation alone, for vars below the "required" floor.
    const t = tpl({ variablesSchema: null, bodyTemplate: 'Hello {{nope}}' });
    expect(() => renderTemplate(t, {})).toThrow(ApiError);
  });
});
