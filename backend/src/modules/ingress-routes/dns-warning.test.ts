import { describe, expect, it } from 'vitest';
import { routeDnsWarning } from './dns-warning.js';

const LEFT = {
  hostnames: ['shop.example.test'],
  reason: "2 of 2 record(s) for 'shop.example.test' are still published — timed out connecting to 100.64.0.9:8081",
};

describe('routeDnsWarning', () => {
  it('tells staff which server failed and why', () => {
    const text = routeDnsWarning(LEFT, true);
    expect(text).toContain("The route is removed, but the DNS records for 'shop.example.test' are still published");
    expect(text).toContain('timed out connecting to 100.64.0.9:8081');
    expect(text).toContain('delete them there once the DNS server answers');
  });

  it('never shows a tenant the DNS server or its address', () => {
    const text = routeDnsWarning(LEFT, false);
    expect(text).toContain("the DNS records for 'shop.example.test' are still published");
    expect(text).not.toContain('100.64.0.9');
    expect(text).not.toContain('timed out');
    expect(text).toContain('They stay listed under DNS Records');
  });

  it('names both hostnames when a www companion was left behind too', () => {
    expect(routeDnsWarning({ ...LEFT, hostnames: ['example.test', 'www.example.test'] }, false))
      .toContain("'example.test' and 'www.example.test'");
  });
});
