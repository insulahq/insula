import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailChromeEditor from './EmailChromeEditor';

const sampleMock = vi.fn();
vi.mock('@/hooks/use-notification-providers', () => ({
  useEmailChromePreviewSample: (enabled: boolean) => sampleMock(enabled),
}));

const SAMPLE_DOC = '<!doctype html><html><head></head><body style="margin:0"><div>SAMPLE-BODY</div></body></html>';

function Harness({ initialHeader = '', initialFooter = '' }: { readonly initialHeader?: string; readonly initialFooter?: string }) {
  const [header, setHeader] = useState(initialHeader);
  const [footer, setFooter] = useState(initialFooter);
  return (
    <EmailChromeEditor
      headerHtml={header}
      footerHtml={footer}
      onHeaderChange={setHeader}
      onFooterChange={setFooter}
    />
  );
}

function previewDoc(): string {
  return (screen.getByTestId('provider-email-preview') as HTMLIFrameElement).getAttribute('srcdoc') ?? '';
}

beforeEach(() => {
  sampleMock.mockReset();
  sampleMock.mockReturnValue({
    data: { data: { subject: 'Your password was changed', html: SAMPLE_DOC } },
    isLoading: false,
    isFetching: false,
    error: null,
  });
});

describe('EmailChromeEditor', () => {
  it('renders two monospace HTML textareas, empty by default', () => {
    render(<Harness />);
    const header = screen.getByTestId('provider-email-header') as HTMLTextAreaElement;
    const footer = screen.getByTestId('provider-email-footer') as HTMLTextAreaElement;
    expect(header.tagName).toBe('TEXTAREA');
    expect(footer.tagName).toBe('TEXTAREA');
    expect(header.value).toBe('');
    expect(footer.value).toBe('');
    expect(header.className).toContain('font-mono');
    expect(footer.className).toContain('font-mono');
  });

  it('previews the sample notification unchanged while both are empty', () => {
    render(<Harness />);
    expect(sampleMock).toHaveBeenCalledWith(true);
    expect(previewDoc()).toBe(SAMPLE_DOC);
  });

  it('renders the preview in a fully sandboxed iframe (no scripts, no same-origin)', () => {
    render(<Harness />);
    const frame = screen.getByTestId('provider-email-preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
  });

  it('live-updates the preview: header above the sample body, footer below', () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId('provider-email-header'), { target: { value: '<p>HEADER-MARK</p>' } });
    fireEvent.change(screen.getByTestId('provider-email-footer'), { target: { value: '<p>FOOTER-MARK</p>' } });
    const doc = previewDoc();
    const order = ['<body style="margin:0">', 'HEADER-MARK', 'SAMPLE-BODY', 'FOOTER-MARK', '</body>'].map((n) => doc.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows the size used against the 20 KB cap', () => {
    render(<Harness initialHeader={'x'.repeat(2048)} />);
    expect(screen.getByTestId('provider-email-header-size')).toHaveTextContent('2.0 KB / 20 KB');
  });

  it('flags forbidden HTML inline, naming the problem', () => {
    render(<Harness />);
    expect(screen.queryByTestId('provider-email-header-problem')).toBeNull();
    fireEvent.change(screen.getByTestId('provider-email-header'), { target: { value: '<img src=x onerror=alert(1)>' } });
    expect(screen.getByTestId('provider-email-header-problem')).toHaveTextContent(/event-handler/);
    fireEvent.change(screen.getByTestId('provider-email-footer'), { target: { value: '<script>x</script>' } });
    expect(screen.getByTestId('provider-email-footer-problem')).toHaveTextContent(/<script>/);
  });

  it('surfaces a failed sample fetch through ErrorPanel and still previews the header/footer', () => {
    sampleMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error('boom'),
    });
    render(<Harness initialHeader="<p>HEADER-MARK</p>" />);
    expect(screen.getByTestId('provider-email-preview-error')).toBeInTheDocument();
    expect(previewDoc()).toContain('HEADER-MARK');
  });
});
