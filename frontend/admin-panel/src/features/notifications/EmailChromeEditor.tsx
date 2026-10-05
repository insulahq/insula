/**
 * Email header & footer editor — part of the email provider drawer.
 *
 * Two HTML textareas and a live preview of a real notification (rendered by
 * the server with sample values) wrapped in them. The wrap is
 * `applyEmailChrome` from the shared contracts, the same function the queue
 * worker sends with, so the preview is the delivered layout rather than a
 * look-alike.
 *
 * The preview iframe is `sandbox=""` + `srcdoc`: operator HTML can never run
 * script or reach the admin panel's origin. Each field validates inline with
 * the contract's own rule, so a problem shows while typing instead of as a 400
 * on save.
 */
import { useDeferredValue, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import {
  EMAIL_CHROME_MAX_BYTES,
  applyEmailChrome,
  emailChromeProblem,
  utf8ByteLength,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useEmailChromePreviewSample } from '@/hooks/use-notification-providers';

interface EmailChromeEditorProps {
  readonly headerHtml: string;
  readonly footerHtml: string;
  readonly onHeaderChange: (value: string) => void;
  readonly onFooterChange: (value: string) => void;
}

const PLACEHOLDER_BODY =
  '<p style="font-family:Arial,sans-serif;font-size:14px;color:#666;text-align:center;padding:24px 0;">The notification body appears here.</p>';

export default function EmailChromeEditor({
  headerHtml,
  footerHtml,
  onHeaderChange,
  onFooterChange,
}: EmailChromeEditorProps) {
  const sample = useEmailChromePreviewSample(true);
  // Typing stays responsive while the iframe re-renders a few KB of HTML.
  const deferredHeader = useDeferredValue(headerHtml);
  const deferredFooter = useDeferredValue(footerHtml);
  const sampleHtml = sample.data?.data.html ?? PLACEHOLDER_BODY;
  const previewHtml = useMemo(
    () => applyEmailChrome(sampleHtml, { headerHtml: deferredHeader, footerHtml: deferredFooter }),
    [sampleHtml, deferredHeader, deferredFooter],
  );

  return (
    <section
      className="space-y-3 rounded-md border border-gray-200 p-3 dark:border-gray-700"
      data-testid="provider-email-chrome"
    >
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Email header &amp; footer</h4>
        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
          HTML placed above and below every notification email this provider sends, including its
          test email. It is inserted exactly as written — template variables such as
          <code className="mx-1 rounded bg-gray-100 px-1 dark:bg-gray-700 dark:text-gray-200">{'{{platformName}}'}</code>
          are not filled in. Leave both empty for none.
        </p>
      </div>
      <ChromeField
        label="Header HTML"
        testId="provider-email-header"
        value={headerHtml}
        onChange={onHeaderChange}
        placeholder={'<div style="text-align:center"><img src="https://example.test/logo.png" alt="Example" height="40"></div>'}
      />
      <ChromeField
        label="Footer HTML"
        testId="provider-email-footer"
        value={footerHtml}
        onChange={onFooterChange}
        placeholder={'<p style="font-size:12px;color:#999;text-align:center">Example Ltd · 1 Example Street</p>'}
      />
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <span>Preview</span>
          {sample.data?.data.subject && (
            <span className="truncate text-gray-400 dark:text-gray-500" title="Sample notification subject">
              — {sample.data.data.subject}
            </span>
          )}
          {sample.isFetching && <Loader2 size={12} className="animate-spin text-gray-400 dark:text-gray-500" />}
        </div>
        {sample.error && (
          <ErrorPanel
            error={extractOperatorError(sample.error)}
            severity="warn"
            compact
            testId="provider-email-preview-error"
          />
        )}
        {/* An email renders on white in every mail client, so the frame is white in both themes. */}
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={previewHtml}
          data-testid="provider-email-preview"
          className="h-96 w-full rounded border border-gray-200 bg-white dark:border-gray-600 dark:bg-white"
        />
      </div>
    </section>
  );
}

interface ChromeFieldProps {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}

function ChromeField({ label, testId, value, onChange, placeholder }: ChromeFieldProps) {
  const problem = emailChromeProblem(value);
  const kb = (utf8ByteLength(value) / 1024).toFixed(1);
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs text-gray-600 dark:text-gray-300">
        {label}
        <span data-testid={`${testId}-size`} className="text-[10px] text-gray-400 dark:text-gray-500">
          {kb} KB / {EMAIL_CHROME_MAX_BYTES / 1024} KB
        </span>
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={problem !== null}
        className={
          'mt-1 w-full rounded border px-2 py-1.5 font-mono text-xs dark:bg-gray-900 dark:text-gray-100 ' +
          (problem
            ? 'border-red-400 dark:border-red-500'
            : 'border-gray-300 dark:border-gray-600')
        }
      />
      {problem && (
        <span data-testid={`${testId}-problem`} className="mt-0.5 block text-[11px] text-red-700 dark:text-red-300">
          HTML {problem}
        </span>
      )}
    </label>
  );
}
