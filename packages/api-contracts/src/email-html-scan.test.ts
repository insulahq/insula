import { describe, it, expect } from 'vitest';
import { decodeCharRefs, scanHtml } from './email-html-scan.js';

describe('scanHtml', () => {
  it('reads start/end tags and their attributes, lower-casing names only', () => {
    const r = scanHtml('<A HREF="https://example.test/X" class=big data-x=\'1\' hidden>t</A>');
    expect(r.issue).toBeNull();
    expect(r.tags).toEqual([
      {
        name: 'a',
        isEnd: false,
        attrs: [
          { name: 'href', value: 'https://example.test/X' },
          { name: 'class', value: 'big' },
          { name: 'data-x', value: '1' },
          { name: 'hidden', value: '' },
        ],
      },
      { name: 'a', isEnd: true, attrs: [] },
    ]);
  });

  it('treats "/" between attributes as a separator, like the browser', () => {
    const [img] = scanHtml('<img/src="x"/alt=y/>').tags;
    expect(img.attrs.map((a) => a.name)).toEqual(['src', 'alt']);
    // An unquoted value runs to whitespace or ">", "/" included.
    expect(img.attrs[1].value).toBe('y/');
  });

  it('keeps raw-text element content out of the tag stream', () => {
    const r = scanHtml('<style>a::before{content:"<b>"}</style><i>x</i>');
    expect(r.tags.map((t) => `${t.isEnd ? '/' : ''}${t.name}`)).toEqual(['style', '/style', 'i', '/i']);
    expect(r.rawText).toEqual([{ tag: 'style', text: 'a::before{content:"<b>"}' }]);
  });

  it('reports why it stopped', () => {
    expect(scanHtml('<p title="x').issue).toEqual({ kind: 'unterminated-tag' });
    expect(scanHtml('<!-- x').issue).toEqual({ kind: 'unclosed-comment' });
    expect(scanHtml('<!x').issue).toEqual({ kind: 'unclosed-markup' });
    expect(scanHtml('<style>x').issue).toEqual({ kind: 'unclosed-raw-text', tag: 'style' });
    expect(scanHtml('<!DOCTYPE html>').issue).toEqual({ kind: 'doctype' });
  });

  it('normalises CR/CRLF before tokenizing', () => {
    expect(scanHtml('<img\r\nonerror=x>').tags[0].attrs[0]).toEqual({ name: 'onerror', value: 'x' });
  });
});

describe('decodeCharRefs', () => {
  it('decodes numeric references with or without ";" and with leading zeros', () => {
    expect(decodeCharRefs('&#106;&#0000097&#x76;&#X61;')).toBe('java');
  });

  it('decodes the named references that can spell a scheme', () => {
    expect(decodeCharRefs('a&colon;b&Tab;c&NewLine;d&lpar;')).toBe('a:b\tc\nd(');
  });

  it('decodes once — an escaped reference stays literal', () => {
    expect(decodeCharRefs('&amp;#106;')).toBe('&#106;');
  });

  it('maps invalid code points to U+FFFD and leaves unknown names alone', () => {
    expect(decodeCharRefs('&#0;&#xD800;&#x110000;')).toBe('\ufffd\ufffd\ufffd');
    expect(decodeCharRefs('&unknownname;')).toBe('&unknownname;');
  });
});
