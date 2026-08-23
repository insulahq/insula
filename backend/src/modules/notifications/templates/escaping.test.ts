import { describe, it, expect } from 'vitest';
import { renderTemplate } from './renderer.js';

const tpl = (bodyFormat: 'plaintext' | 'mjml', body: string) => ({
  id: `esc-${bodyFormat}-${body.length}`, categoryId: 'c', channel: bodyFormat === 'mjml' ? 'email' : 'in_app',
  locale: 'en', subjectTemplate: 'S {{v}}', bodyTemplate: body, bodyFormat,
  variablesSchema: [{ name: 'v', type: 'string', required: false }],
  version: 1, isActive: true, isSeed: true,
} as unknown as Parameters<typeof renderTemplate>[0]);

describe('template escaping is format-aware', () => {
  it('plaintext (in-app) does NOT HTML-escape symbols', () => {
    // Regression: `=` used to render as `&#x3D;` in the in-app dropdown.
    const { body } = renderTemplate(tpl('plaintext', 'drift: {{v}}'), { v: 'PermitRootLogin=yes & more' });
    expect(body).toBe('drift: PermitRootLogin=yes & more');
    expect(body).not.toContain('&#x3D;');
    expect(body).not.toContain('&amp;');
  });

  it('subjects are never HTML-escaped', () => {
    const { subject } = renderTemplate(tpl('plaintext', 'x'), { v: 'a=b & c' });
    expect(subject).toBe('S a=b & c');
  });

  it('mjml (HTML email) DOES escape user variables (injection safety)', () => {
    const { body } = renderTemplate(tpl('mjml', '<mj-text>{{v}}</mj-text>'), { v: '<script>alert(1)</script>' }, { skipMjml: true });
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
