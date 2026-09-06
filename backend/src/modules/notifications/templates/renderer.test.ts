import { describe, it, expect, beforeEach } from 'vitest';
import { renderTemplate, renderTemplateAsync, _resetRendererCacheForTests } from './renderer.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';
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

  it('does NOT HTML-escape plaintext bodies (in-app + text/plain are not HTML)', () => {
    // Plaintext is shown as text: the in-app dropdown renders it through React
    // (escapes at display) and email uses a text/plain part. HTML-escaping here
    // was wrong — it turned symbols like `=` into `&#x3D;` in the message.
    // Injection safety for the HTML (MJML) path is asserted in the email tests.
    const r = renderTemplate(
      tpl({ bodyTemplate: 'value: {{userName}}' }),
      { userName: 'a=b & <x>' },
    );
    expect(r.body).toBe('value: a=b & <x>');
    expect(r.body).not.toContain('&#x3D;');
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

describe('renderTemplate — optional variables under strict mode', () => {
  // CHARACTERISATION, not regression: these pass before and after the SLO
  // template change and exist to PIN the behaviour those templates rely on.
  //
  // Strict mode throws on a bare `{{x}}` whose key is absent, which is why it
  // is worth stating explicitly that a block-helper param is exempt — the
  // admin.slo_alert_* templates guard every optional variable with `{{#if}}`,
  // and the queue worker re-renders old event_variables rows that predate
  // those variables and legitimately lack the keys. If a future change to the
  // compile options (strict / knownHelpersOnly) breaks this exemption, those
  // retries would start throwing; that regression should surface here rather
  // than as a dead-lettered alert.
  const optionalTpl = (body: string) => tpl({
    id: `opt-${body.length}`,
    subjectTemplate: 'S',
    bodyTemplate: body,
    variablesSchema: [
      { name: 'userName', type: 'string', required: true },
      { name: 'affected', type: 'string', required: false },
    ],
  });

  it('renders {{#if optional}} when the key is absent from the variables', () => {
    const r = renderTemplate(optionalTpl('Hi{{#if affected}} — {{affected}}{{/if}}'), { userName: 'A' });
    expect(r.body).toBe('Hi');
  });

  it('renders the block when the optional variable IS supplied', () => {
    const r = renderTemplate(
      optionalTpl('Hi{{#if affected}} — {{affected}}{{/if}}'),
      { userName: 'A', affected: 'host=example.test' },
    );
    expect(r.body).toBe('Hi — host=example.test');
  });

  it('treats an explicit null the same as absent', () => {
    const r = renderTemplate(
      optionalTpl('Hi{{#if affected}} — {{affected}}{{/if}}'),
      { userName: 'A', affected: null },
    );
    expect(r.body).toBe('Hi');
  });

  it('still throws for a REQUIRED variable that is absent', () => {
    expect(() => renderTemplate(optionalTpl('Hi {{userName}}'), {}))
      .toThrow(/Missing required template variable/);
  });

  it('applies the same backfill on the async (email) path', async () => {
    const r = await renderTemplateAsync(
      optionalTpl('Hi{{#if affected}} — {{affected}}{{/if}}'), { userName: 'A' },
    );
    expect(r.body).toBe('Hi');
  });
});
