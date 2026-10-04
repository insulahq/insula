/**
 * Several items in one notification arrive as a list on every channel — the
 * operator's requirement, after "Acme: … Beta: … SYSTEM: …" kept arriving as
 * one paragraph in the email, the in-app feed and the push.
 */
import { describe, it, expect } from 'vitest';
import type { NotificationTemplateResponse } from '@insula/api-contracts';
import { formatList, prepareListVariables } from './list-vars.js';
import { renderTemplateAsync } from './renderer.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';

describe('formatList', () => {
  it('an HTML body gets an escaped <ul>, one <li> per item', () => {
    const html = String(formatList(['Acme <b>', 'Beta & co'], 'html'));
    expect(html).toMatch(/^<ul[^>]*><li[^>]*>Acme &lt;b&gt;<\/li><li[^>]*>Beta &amp; co<\/li><\/ul>$/);
  });

  it('a plaintext body gets one bullet line per item', () => {
    expect(formatList(['Acme', 'Beta'], 'text')).toBe('\n• Acme\n• Beta\n');
  });

  it('a subject stays one line', () => {
    expect(formatList(['Acme', 'Beta'], 'subject')).toBe('Acme, Beta');
  });

  it('drops blank items, and an empty list renders nothing', () => {
    expect(formatList([' ', ''], 'text')).toBe('');
    expect(formatList(['Acme', '  '], 'subject')).toBe('Acme');
  });

  it('leaves non-list values alone', () => {
    const vars = { a: 'x', n: 3 };
    expect(prepareListVariables(vars, 'html')).toBe(vars);
  });

  it('still escapes an array that slipped through with nulls or numbers', () => {
    const html = String(formatList(['<script>', null, 3, undefined], 'html'));
    expect(html).toMatch(/<li[^>]*>&lt;script&gt;<\/li><li[^>]*>3<\/li><\/ul>$/);
  });
});

function seed(categoryId: string, channel: string): NotificationTemplateResponse {
  const t = ALL_SEED_TEMPLATES.find((x) => x.categoryId === categoryId && x.channel === channel);
  if (!t) throw new Error(`no seed ${categoryId}/${channel}`);
  return { ...t, id: `${categoryId}:${channel}`, version: 1, isActive: true, updatedAt: new Date().toISOString() } as unknown as NotificationTemplateResponse;
}

describe('the tenant-misplaced notification, as the operator receives it', () => {
  const vars = {
    platformName: 'Insula', userName: 'Op', greeting: null, occurredAt: null, actionButtons: '',
    summary: '3 tenants',
    details: [
      'Untamed: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
      'Expiry: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
      'SYSTEM: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
    ],
    guidance: 'Open the tenant\'s Placement card to move it back.',
  };

  it('email: each tenant is its own list item', async () => {
    const r = await renderTemplateAsync(seed('admin.tenant_misplaced', 'email'), vars);
    expect(r.body.match(/<li\b/g)).toHaveLength(3);
    expect(r.body).toContain('Untamed: primary node sv1');
    expect(r.subject).toBe('[PLACEMENT] Not on its primary node: 3 tenants');
  });

  it('in-app and push: each tenant on its own bullet line, then the guidance', async () => {
    for (const channel of ['in_app', 'ntfy']) {
      const r = await renderTemplateAsync(seed('admin.tenant_misplaced', channel), vars);
      expect(r.body.split('\n')).toEqual([
        '• Untamed: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
        '• Expiry: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
        '• SYSTEM: primary node sv1, but data on sv2 (seen since 2026-10-03 16:54 UTC).',
        '',
        'Open the tenant\'s Placement card to move it back.',
      ]);
    }
  });
});
