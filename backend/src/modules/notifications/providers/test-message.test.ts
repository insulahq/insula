import { describe, it, expect } from 'vitest';
import { buildProviderTestMessage, htmlToText } from './test-message.js';

describe('buildProviderTestMessage', () => {
  it('without a header/footer is exactly the historical text-only message', () => {
    const msg = buildProviderTestMessage('Relay', { headerHtml: '', footerHtml: '' });
    expect(msg).toEqual({
      text: 'This is an automated test from the notification provider "Relay". If you received this, the provider\'s SMTP credentials are working.\n',
    });
    expect(msg.html).toBeUndefined();
  });

  it('with a header/footer adds an HTML part wrapped in them, in order', () => {
    const msg = buildProviderTestMessage('Relay', {
      headerHtml: '<p>HEADER-MARK</p>',
      footerHtml: '<p>FOOTER-MARK</p>',
    });
    expect(msg.html).toBeDefined();
    const html = msg.html ?? '';
    const h = html.indexOf('HEADER-MARK');
    const b = html.indexOf('automated test');
    const f = html.indexOf('FOOTER-MARK');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(b);
    expect(b).toBeLessThan(f);
  });

  it('escapes the provider name in the HTML part', () => {
    const msg = buildProviderTestMessage('<b>x</b> & co', { footerHtml: 'F' });
    expect(msg.html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; co');
    expect(msg.html).not.toContain('<b>x</b>');
  });

  it('gives the text part a tag-stripped header and footer around the same sentence', () => {
    const msg = buildProviderTestMessage('Relay', {
      headerHtml: '<div style="text-align:center"><strong>ACME&nbsp;Hosting</strong></div>',
      footerHtml: '<p>ACME Ltd &middot; <a href="https://example.test/legal">Legal</a></p>',
    });
    expect(msg.text).toBe([
      'ACME Hosting',
      'This is an automated test from the notification provider "Relay". If you received this, the provider\'s SMTP credentials are working.',
      'ACME Ltd · Legal (https://example.test/legal)',
    ].join('\n\n') + '\n');
  });

  it('omits a block whose text rendering is empty (an image-only header)', () => {
    const msg = buildProviderTestMessage('Relay', { headerHtml: '<img src="https://example.test/l.png">' });
    expect(msg.text.startsWith('This is an automated test')).toBe(true);
    expect(msg.html).toContain('<img src="https://example.test/l.png">');
  });
});

describe('htmlToText', () => {
  it('returns empty for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
  });

  it('turns block ends and <br> into line breaks and collapses spacing', () => {
    expect(htmlToText('<p>One   two</p>\n\n<div>Three<br>Four</div>')).toBe('One two\nThree\nFour');
  });

  it('drops comments, <style> and <title> content', () => {
    expect(htmlToText('<style>p{color:red}</style><!-- note --><p>Shown</p>')).toBe('Shown');
  });

  it('decodes entities once (no double decoding)', () => {
    expect(htmlToText('&lt;tag&gt; &amp;amp; &#39;q&#39; &#x41; &quot;')).toBe('<tag> &amp; \'q\' A "');
  });

  it('keeps a link target unless the text already says it', () => {
    expect(htmlToText('<a href="https://example.test/x">Docs</a>')).toBe('Docs (https://example.test/x)');
    expect(htmlToText('<a href="https://example.test/">https://example.test/</a>')).toBe('https://example.test/');
    expect(htmlToText('<a href="mailto:ops@example.test">ops@example.test</a>')).toBe('ops@example.test');
  });

  it('renders list items as bullets', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('• a\n• b');
  });
});
