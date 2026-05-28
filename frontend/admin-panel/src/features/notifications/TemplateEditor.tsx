/**
 * Notification Template editor — full-screen modal for editing a single
 * Handlebars template. Surfaces subject + body textareas, a read-only
 * Variables panel, an inline preview pane (sandboxed iframe for email
 * HTML output, plain text for in_app), Save (refused when no changes)
 * and Restore-stock-template (inline confirm — no window.confirm).
 *
 * The preview iframe has `sandbox=""` and `srcdoc` only — no script
 * execution, no network. Body format from the preview response dictates
 * rendering: mjml/html → iframe; plaintext/markdown → <pre>.
 */

import { useEffect, useMemo, useState } from 'react';
import { History, Loader2, RotateCcw, Save, X } from 'lucide-react';
import {
  useNotificationTemplate,
  useUpdateNotificationTemplate,
  usePreviewNotificationTemplate,
  useRestoreNotificationTemplate,
} from '@/hooks/use-notification-templates';
import type {
  NotificationTemplateVariable,
  PreviewNotificationTemplateResponse,
} from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface TemplateEditorProps {
  readonly templateId: string;
  readonly onClose: () => void;
}

function buildSampleVars(
  schema: ReadonlyArray<NotificationTemplateVariable> | null,
): Record<string, string | number | boolean> {
  if (!schema) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const v of schema) {
    if (v.type === 'string') out[v.name] = `sample-${v.name}`;
    else if (v.type === 'number') out[v.name] = 42;
    else if (v.type === 'boolean') out[v.name] = true;
    else if (v.type === 'date') out[v.name] = new Date().toISOString();
  }
  return out;
}

export default function TemplateEditor({ templateId, onClose }: TemplateEditorProps) {
  const detail = useNotificationTemplate(templateId);
  const update = useUpdateNotificationTemplate();
  const preview = usePreviewNotificationTemplate();
  const restore = useRestoreNotificationTemplate();

  const template = detail.data?.data;

  const [subject, setSubject] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [previewVars, setPreviewVars] = useState<string>('{}');
  const [previewVarsError, setPreviewVarsError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewNotificationTemplateResponse | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  // Sync local state when detail loads / refreshes. Depend on the
  // STABLE id + version (not the whole `template` object reference),
  // otherwise a background refetch that returns a fresh object with
  // the same data wipes the operator's unsaved edits mid-edit.
  useEffect(() => {
    if (template) {
      setSubject(template.subjectTemplate ?? '');
      setBody(template.bodyTemplate);
      setPreviewVars(JSON.stringify(buildSampleVars(template.variablesSchema), null, 2));
      setPreviewVarsError(null);
    }
  }, [template?.id, template?.version]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const hasChanges = useMemo(() => {
    if (!template) return false;
    return body !== template.bodyTemplate || subject !== (template.subjectTemplate ?? '');
  }, [template, subject, body]);

  const onPreview = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPreviewResult(null);
    setPreviewVarsError(null);
    let parsed: Record<string, string | number | boolean>;
    try {
      parsed = JSON.parse(previewVars) as Record<string, string | number | boolean>;
    } catch (err) {
      // Surface invalid JSON so the operator doesn't get a confusing
      // "missing required variable" downstream when the actual cause
      // is a typo in their preview-vars textarea.
      setPreviewVarsError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    try {
      const res = await preview.mutateAsync({
        id: templateId,
        input: { variables: parsed },
      });
      setPreviewResult(res.data);
    } catch {
      // ErrorPanel surfaces it below
    }
  };

  const onSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!hasChanges || !template) return;
    try {
      await update.mutateAsync({
        id: templateId,
        input: {
          subjectTemplate: subject || null,
          bodyTemplate: body,
        },
      });
    } catch {
      // ErrorPanel surfaces it
    }
  };

  const onConfirmRestore = async (): Promise<void> => {
    try {
      await restore.mutateAsync(templateId);
      setConfirmRestore(false);
    } catch {
      // ErrorPanel surfaces it
    }
  };

  const renderedSubject = previewResult?.subject ?? null;
  const renderedBody = previewResult?.body ?? null;
  const renderedFormat = previewResult?.bodyFormat ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="template-editor"
      onKeyDown={onKeyDown}
    >
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Edit Template
            </h3>
            {template && (
              <>
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono dark:bg-gray-700 dark:text-gray-200">
                  {template.categoryId} · {template.channel} · {template.locale}
                </span>
                {template.isSeed && (
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                    seed
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                  <History size={11} /> v{template.version} · last edited {new Date(template.updatedAt).toLocaleString()}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {detail.isLoading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {detail.error && (
          <div className="p-4">
            <ErrorPanel
              error={extractOperatorError(detail.error)}
              severity="error"
              testId="template-detail-error"
            />
          </div>
        )}

        {template && (
          <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-3">
            {/* Editor column */}
            <form
              onSubmit={onSave}
              className="col-span-2 flex flex-col overflow-y-auto rounded border border-gray-200 p-3 dark:border-gray-700"
            >
              {template.channel === 'email' && (
                <label className="block text-xs text-gray-600 dark:text-gray-300">
                  Subject template (Handlebars)
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    data-testid="template-subject"
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
              )}
              <label className="mt-3 flex-1 text-xs text-gray-600 dark:text-gray-300">
                Body template ({template.bodyFormat})
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  data-testid="template-body"
                  spellCheck={false}
                  className="mt-1 h-full min-h-[300px] w-full resize-y rounded border border-gray-300 px-2 py-1 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </label>

              {update.error && (
                <div className="mt-3">
                  <ErrorPanel
                    error={extractOperatorError(update.error)}
                    severity="error"
                    testId="template-save-error"
                    compact
                  />
                </div>
              )}

              <div className="mt-3 flex items-center justify-between gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                {!confirmRestore ? (
                  <button
                    type="button"
                    onClick={() => setConfirmRestore(true)}
                    className="inline-flex items-center gap-1 rounded border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-900/30"
                    data-testid="restore-seed-button"
                  >
                    <RotateCcw size={12} /> Restore stock template
                  </button>
                ) : (
                  <div className="flex items-center gap-2" data-testid="restore-confirm">
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      Replace current edits with the stock template?
                    </span>
                    <button
                      type="button"
                      onClick={onConfirmRestore}
                      disabled={restore.isPending}
                      className="rounded bg-amber-600 px-2 py-0.5 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
                      data-testid="restore-confirm-yes"
                    >
                      {restore.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Yes, restore'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRestore(false)}
                      className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!hasChanges || update.isPending}
                  data-testid="template-save"
                  className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {update.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save
                </button>
              </div>
            </form>

            {/* Side column: variables + preview */}
            <div className="flex flex-col gap-3 overflow-y-auto">
              <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
                <h4 className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-200">
                  Variables
                </h4>
                {template.variablesSchema && template.variablesSchema.length > 0 ? (
                  <ul className="space-y-1 text-[11px] text-gray-700 dark:text-gray-200">
                    {template.variablesSchema.map((v) => (
                      <li key={v.name} className="font-mono">
                        {v.name}: <span className="text-gray-500">{v.type}</span>
                        {v.required && <span className="ml-1 text-red-600 dark:text-red-400">*</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-gray-500">No variables declared.</p>
                )}
              </section>

              <form
                onSubmit={onPreview}
                className="flex flex-col gap-2 rounded border border-gray-200 p-3 dark:border-gray-700"
              >
                <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">Preview</h4>
                <label className="text-[11px] text-gray-600 dark:text-gray-300">
                  Sample variables (JSON)
                  <textarea
                    value={previewVars}
                    onChange={(e) => { setPreviewVars(e.target.value); setPreviewVarsError(null); }}
                    data-testid="preview-vars"
                    className="mt-1 h-24 w-full resize-y rounded border border-gray-300 p-1 font-mono text-[11px] dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                {previewVarsError && (
                  <p
                    className="text-[11px] text-red-700 dark:text-red-300"
                    data-testid="preview-vars-error"
                    role="alert"
                  >
                    Invalid JSON: {previewVarsError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={preview.isPending}
                  data-testid="preview-button"
                  className="self-end rounded bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:hover:bg-gray-600"
                >
                  {preview.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Render preview'}
                </button>

                {preview.error && (
                  <ErrorPanel
                    error={extractOperatorError(preview.error)}
                    severity="error"
                    testId="preview-error"
                    compact
                  />
                )}

                {previewResult && (
                  <div className="space-y-2" data-testid="preview-output">
                    {renderedSubject !== null && (
                      <div>
                        <p className="text-[10px] uppercase text-gray-500">Subject</p>
                        <p className="font-mono text-xs text-gray-900 dark:text-gray-100">{renderedSubject}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] uppercase text-gray-500">Body ({renderedFormat})</p>
                      {(renderedFormat === 'mjml' || renderedFormat === 'html') ? (
                        <iframe
                          // Sandboxed: no scripts, no plugins, no top navigation,
                          // no form submission to outside origin. srcdoc only,
                          // so no network requests. Preview is render-only.
                          sandbox=""
                          srcDoc={renderedBody ?? ''}
                          title="Email preview"
                          className="h-64 w-full rounded border border-gray-300 bg-white dark:border-gray-600"
                          data-testid="preview-iframe"
                        />
                      ) : (
                        <pre
                          className="max-h-64 overflow-auto rounded border border-gray-300 bg-gray-50 p-2 text-[11px] dark:border-gray-600 dark:bg-gray-900"
                          data-testid="preview-plaintext"
                        >
                          {renderedBody}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </form>

              {restore.error && (
                <ErrorPanel
                  error={extractOperatorError(restore.error)}
                  severity="error"
                  testId="restore-error"
                  compact
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
