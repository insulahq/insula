// Monaco YAML editor, lazy-loaded by ComposeEditor (React.lazy) so the editor
// bundle does not inflate the main chunk; ComposeEditor's ErrorBoundary falls
// back to a plain textarea if it cannot load.
//
// Validation is the server's: Validate puts its issues on the lines as markers
// (below). monaco-yaml's in-editor schema checks were removed — its worker
// protocol does not work with monaco-editor >= 0.55 (it threw "Missing
// requestHandler or method: doValidation"), and it was 1 MB of bundle.

import '@/lib/monaco-setup';
import { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';

/** One backend issue that resolved to a line in this document. */
export interface EditorMarker {
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Accepted for API stability; the server validates against it. */
  jsonSchema?: unknown;
  /**
   * Backend validation issues to render as squiggles. The JSON Schema already
   * catches shape mistakes as you type; these are the SEMANTIC ones only the
   * server knows (rejected fields, unreachable images, a limit below its
   * reservation) — previously they existed only as text in a side pane, so a
   * tenant had to map a dotted path onto a 60-line document by eye.
   */
  markers?: readonly EditorMarker[];
  /**
   * Scroll the editor to a line and put the caret on it. Passed as an OBJECT,
   * not a number: the effect keys on identity, so clicking the same issue
   * twice re-reveals. A bare number would compare equal and do nothing the
   * second time, which reads as a broken button.
   */
  revealLine?: { readonly line: number } | null;
}

export default function MonacoYamlEditor({ value, onChange, markers, revealLine }: Props) {
  const editorRef = useRef<Parameters<NonNullable<Parameters<typeof Editor>[0]['onMount']>>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // A dedicated marker owner, so we only ever clear OUR markers.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    monaco.editor.setModelMarkers(model, 'insula-compose', (markers ?? []).map((m) => {
      // The backend resolves a line, not a column, so underline the whole
      // line's content. A bogus line (document edited since validating) is
      // clamped rather than dropped, so the marker never lands out of range.
      const line = Math.min(Math.max(m.line, 1), model.getLineCount());
      return {
        startLineNumber: line,
        endLineNumber: line,
        startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1,
        endColumn: model.getLineMaxColumn(line),
        message: `${m.code}: ${m.message}`,
        severity: m.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : m.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      };
    }));
  }, [markers, value]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !revealLine) return;
    const line = Math.min(Math.max(revealLine.line, 1), model.getLineCount());
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, [revealLine]);

  return (
    <Editor
      height="100%"
      language="yaml"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        renderWhitespace: 'trailing',
        tabSize: 2,
      }}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
      }}
      data-testid="custom-compose-monaco"
    />
  );
}
