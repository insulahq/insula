// Monaco + monaco-yaml lazy-loaded YAML editor. Wired to the platform's
// compose JSON Schema for per-field validation, autocomplete, and hover.
//
// This module is dynamically imported by ComposeEditor via React.lazy so
// its ~1.5 MB bundle does not inflate the main chunk. If monaco-yaml fails
// to initialise (e.g. missing CDN worker), ComposeEditor's ErrorBoundary
// catches the error and falls back to a plain textarea.

import { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';

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
  jsonSchema: unknown;
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

let yamlConfigured = false;

function ensureYaml(monaco: Monaco, schema: unknown) {
  if (yamlConfigured) return;
  yamlConfigured = true;
  configureMonacoYaml(monaco, {
    enableSchemaRequest: false,
    hover: true,
    completion: true,
    validate: true,
    format: {},
    schemas: schema
      ? [
          {
            uri: 'platform://compose-schema',
            fileMatch: ['*'],
            schema: schema as object,
          },
        ]
      : [],
  });
}

export default function MonacoYamlEditor({ value, onChange, jsonSchema, markers, revealLine }: Props) {
  const schemaRef = useRef(jsonSchema);
  schemaRef.current = jsonSchema;
  const editorRef = useRef<Parameters<NonNullable<Parameters<typeof Editor>[0]['onMount']>>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  useEffect(() => {
    yamlConfigured = false;
  }, [jsonSchema]);

  // Own a dedicated marker owner string so we only ever clear OUR markers —
  // monaco-yaml owns its own set from the JSON Schema and both must coexist.
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
        ensureYaml(monaco, schemaRef.current);
      }}
      data-testid="custom-compose-monaco"
    />
  );
}
