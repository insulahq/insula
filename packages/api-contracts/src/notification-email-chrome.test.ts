import { describe, it, expect } from 'vitest';
import {
  EMAIL_CHROME_MAX_BYTES,
  applyEmailChrome,
  emailChromeHtmlSchema,
  emailChromeProblem,
  hasEmailChrome,
  utf8ByteLength,
} from './notification-email-chrome.js';
import {
  createNotificationProviderSchema,
  updateNotificationProviderSchema,
} from './notification-providers.js';

const MJML_LIKE_DOC = [
  '<!doctype html><html><head><title></title><style>p{margin:13px 0}</style></head>',
  '<body style="word-spacing:normal;"><div lang="und" dir="auto"><p>Body text</p></div></body></html>',
].join('');

describe('applyEmailChrome', () => {
  it('returns the body byte-for-byte when header and footer are empty', () => {
    expect(applyEmailChrome(MJML_LIKE_DOC, { headerHtml: '', footerHtml: '' })).toBe(MJML_LIKE_DOC);
  });

  it('treats null, undefined and whitespace-only as empty', () => {
    expect(applyEmailChrome(MJML_LIKE_DOC, {})).toBe(MJML_LIKE_DOC);
    expect(applyEmailChrome(MJML_LIKE_DOC, { headerHtml: null, footerHtml: null })).toBe(MJML_LIKE_DOC);
    expect(applyEmailChrome(MJML_LIKE_DOC, { headerHtml: '  \n ', footerHtml: '\t' })).toBe(MJML_LIKE_DOC);
  });

  it('puts the header right after <body> and the footer right before </body>', () => {
    const out = applyEmailChrome(MJML_LIKE_DOC, {
      headerHtml: '<p>HEADER-MARK</p>',
      footerHtml: '<p>FOOTER-MARK</p>',
    });
    const bodyOpen = out.indexOf('<body style="word-spacing:normal;">');
    const header = out.indexOf('HEADER-MARK');
    const body = out.indexOf('Body text');
    const footer = out.indexOf('FOOTER-MARK');
    const bodyClose = out.indexOf('</body>');
    expect(bodyOpen).toBeGreaterThanOrEqual(0);
    expect(bodyOpen).toBeLessThan(header);
    expect(header).toBeLessThan(body);
    expect(body).toBeLessThan(footer);
    expect(footer).toBeLessThan(bodyClose);
    // Nothing of the original document is lost or reordered.
    expect(out.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(out.endsWith('</body></html>')).toBe(true);
  });

  it('wraps each block in a centred column matching the 600px email body', () => {
    const out = applyEmailChrome(MJML_LIKE_DOC, { headerHtml: '<b>H</b>' });
    expect(out).toContain('<div style="margin:0 auto;max-width:600px;"><b>H</b></div>');
  });

  it('inserts the operator HTML verbatim — no template variable is interpolated', () => {
    const out = applyEmailChrome(MJML_LIKE_DOC, { headerHtml: 'Hello {{userName}} &amp; co' });
    expect(out).toContain('Hello {{userName}} &amp; co');
  });

  it('applies only the block that is set', () => {
    const onlyFooter = applyEmailChrome(MJML_LIKE_DOC, { footerHtml: '<i>F</i>' });
    expect(onlyFooter).toContain('<i>F</i></div></body>');
    expect(onlyFooter).toContain('<body style="word-spacing:normal;"><div lang="und"');
  });

  it('matches <body> and </body> case-insensitively and uses the LAST </body>', () => {
    const doc = '<HTML><BODY class="x">a</BODY>b</Body ></HTML>';
    const out = applyEmailChrome(doc, { headerHtml: 'HDR', footerHtml: 'FTR' });
    expect(out).toContain('<BODY class="x"><div style="margin:0 auto;max-width:600px;">HDR</div>a</BODY>b');
    expect(out).toContain('FTR</div></Body ></HTML>');
  });

  it('appends the footer at the end when the document has <body> but no </body>', () => {
    const out = applyEmailChrome('<body>x', { footerHtml: 'F' });
    expect(out).toBe('<body>x<div style="margin:0 auto;max-width:600px;">F</div>');
  });

  it('surrounds a fragment that has no <body> at all', () => {
    const out = applyEmailChrome('<p>frag</p>', { headerHtml: 'H', footerHtml: 'F' });
    expect(out).toBe(
      '<div style="margin:0 auto;max-width:600px;">H</div><p>frag</p><div style="margin:0 auto;max-width:600px;">F</div>',
    );
  });

  it('does not mistake <bodyfoo> for <body>', () => {
    const out = applyEmailChrome('<bodyfoo>x</bodyfoo>', { headerHtml: 'H' });
    expect(out.startsWith('<div style="margin:0 auto;max-width:600px;">H</div><bodyfoo>')).toBe(true);
  });
});

describe('hasEmailChrome', () => {
  it('is false for empty/blank and true when either block has content', () => {
    expect(hasEmailChrome({})).toBe(false);
    expect(hasEmailChrome({ headerHtml: ' ', footerHtml: '' })).toBe(false);
    expect(hasEmailChrome({ headerHtml: 'x' })).toBe(true);
    expect(hasEmailChrome({ footerHtml: '<hr>' })).toBe(true);
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('emailChromeProblem / emailChromeHtmlSchema', () => {
  it('accepts empty and ordinary email HTML', () => {
    expect(emailChromeProblem('')).toBeNull();
    const ok = [
      '<table role="presentation" width="100%"><tr><td style="text-align:center">',
      '<img src="https://example.test/logo.png" alt="Example" height="40">',
      '</td></tr></table>',
      '<style>.x{color:#333}</style><!-- legal footer -->',
      '<p style="font-family:Montserrat, sans-serif; text-decoration:none">ACME · <a href="mailto:ops@example.test">Contact</a></p>',
    ].join('');
    expect(emailChromeProblem(ok)).toBeNull();
    expect(emailChromeHtmlSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts exactly the size cap and rejects one byte over', () => {
    expect(emailChromeProblem('a'.repeat(EMAIL_CHROME_MAX_BYTES))).toBeNull();
    expect(emailChromeProblem('a'.repeat(EMAIL_CHROME_MAX_BYTES + 1))).toMatch(/20 KB/);
    // Multi-byte characters count by their encoded size.
    expect(emailChromeProblem('é'.repeat(EMAIL_CHROME_MAX_BYTES / 2 + 1))).toMatch(/20 KB/);
  });

  it.each([
    ['<script>alert(1)</script>', /<script>/],
    ['<SCRIPT src="https://example.test/x.js"></SCRIPT>', /<script>/],
    ['< script>x', /<script>/],
    ['<iframe src="https://example.test"></iframe>', /<iframe>/],
    ['<object data="x"></object>', /<object>/],
    ['<embed src="x">', /<embed>/],
    ['<form action="https://example.test"><input></form>', /<form>/],
    ['<meta http-equiv="refresh" content="0">', /<meta>/],
    ['<base href="https://example.test/">', /<base>/],
    ['</body><p>x</p>', /<body>/],
    ['<html><p>x</p></html>', /<html>/],
    ['<head></head>', /<head>/],
    ['<textarea>', /<textarea>/],
    ['<!DOCTYPE html><p>x</p>', /DOCTYPE/],
  ])('rejects %s', (html, msg) => {
    const problem = emailChromeProblem(html);
    expect(problem).toMatch(msg);
    const parsed = emailChromeHtmlSchema.safeParse(html);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].message).toMatch(msg);
  });

  it.each([
    '<img src="x.png" onerror="alert(1)">',
    '<img src=x ONLOAD=alert(1)>',
    '<svg/onload=alert(1)>',
    '<a href="#" onclick = "x()">a</a>',
    '<div\nonmouseover="x()">a</div>',
  ])('rejects the event-handler attribute in %s', (html) => {
    expect(emailChromeProblem(html)).toMatch(/event-handler/);
  });

  it.each([
    '<a href="javascript:alert(1)">x</a>',
    '<a href=\'  JavaScript:alert(1)\'>x</a>',
    '<a href=vbscript:msgbox(1)>x</a>',
  ])('rejects the script URL in %s', (html) => {
    expect(emailChromeProblem(html)).toMatch(/javascript:/);
  });

  it('rejects an unclosed comment, which would hide the rest of the email', () => {
    expect(emailChromeProblem('<p>x</p><!-- todo')).toMatch(/comment/);
    expect(emailChromeProblem('<!-- a --><p>x</p><!-- b')).toMatch(/comment/);
    expect(emailChromeProblem('<!-- a --><p>x</p>')).toBeNull();
  });

  it('rejects an unclosed <style>, which would swallow the email body as CSS', () => {
    expect(emailChromeProblem('<style>p{color:red}')).toMatch(/<style>/);
    expect(emailChromeProblem('<style>a{}</style><style>b{}')).toMatch(/<style>/);
  });

  it('does not flag words that merely contain "on" or tags that start with a forbidden name', () => {
    expect(emailChromeProblem('<p title="Contact us on Monday">Montserrat online=yes</p>')).toBeNull();
    expect(emailChromeProblem('<p data-onboarding="1">x</p>')).toBeNull();
    expect(emailChromeProblem('<bodyish>x</bodyish>')).toBeNull();
    expect(emailChromeProblem('<a href="https://example.test/javascript-guide">guide</a>')).toBeNull();
  });
});

describe('provider schemas carry the chrome fields', () => {
  const smtpCreate = {
    name: 'p',
    providerType: 'smtp' as const,
    smtpHost: 'smtp.example.test',
    fromAddress: 'noreply@example.test',
  };

  it('create accepts header/footer HTML and leaves them optional', () => {
    expect(createNotificationProviderSchema.safeParse(smtpCreate).success).toBe(true);
    const parsed = createNotificationProviderSchema.safeParse({
      ...smtpCreate,
      emailHeaderHtml: '<p>H</p>',
      emailFooterHtml: '<p>F</p>',
    });
    expect(parsed.success).toBe(true);
  });

  it('create rejects forbidden header HTML on the right path', () => {
    const parsed = createNotificationProviderSchema.safeParse({
      ...smtpCreate,
      emailHeaderHtml: '<script>x</script>',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['emailHeaderHtml']);
  });

  it('create rejects a header/footer on an ntfy provider (it is not an email)', () => {
    const parsed = createNotificationProviderSchema.safeParse({
      name: 'push',
      providerType: 'ntfy',
      ntfyTopic: 'alerts',
      emailFooterHtml: '<p>F</p>',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['emailFooterHtml']);
    // An explicitly empty value is not a header at all.
    expect(createNotificationProviderSchema.safeParse({
      name: 'push', providerType: 'ntfy', ntfyTopic: 'alerts', emailFooterHtml: '',
    }).success).toBe(true);
  });

  it('update validates the same way and accepts clearing to empty', () => {
    expect(updateNotificationProviderSchema.safeParse({ emailFooterHtml: '' }).success).toBe(true);
    expect(updateNotificationProviderSchema.safeParse({ emailFooterHtml: '<p>F</p>' }).success).toBe(true);
    const bad = updateNotificationProviderSchema.safeParse({ emailFooterHtml: '<img src=x onerror=y>' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].path).toEqual(['emailFooterHtml']);
  });
});
