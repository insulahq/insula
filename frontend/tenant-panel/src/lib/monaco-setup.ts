/**
 * Monaco is served from this image, never from a CDN.
 *
 * `@monaco-editor/react` loads Monaco from cdn.jsdelivr.net unless told
 * otherwise: every tenant's browser fetched third-party code at runtime,
 * leaking its address to the CDN and failing on firewalled or offline
 * clusters. `loader.config({ monaco })` hands it the bundled copy instead.
 *
 * Lean on purpose — the editor core, syntax highlighting for the languages our
 * editors actually use (Files' LANG_MAP, SQL Manager, the compose editor), the
 * YAML worker for monaco-yaml. The TypeScript / CSS / HTML / JSON language
 * services (IntelliSense, validation) are left out: they are most of Monaco's
 * weight (the JSON service alone is 1.6 MB) and a hosting panel's file editor
 * needs highlighting, not a compiler. JSON gets a small Monarch highlighter.
 *
 * Import this module from every file that renders an editor, before the editor
 * mounts; Vite puts it in the editors' lazy chunk. monaco-editor stays on the
 * version monaco-yaml's peer range already locked (0.56): the deep-import alias
 * in vite.config.ts and the definitions paths were verified against it.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/mysql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import YamlWorker from 'monaco-yaml/yaml.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'yaml') return new YamlWorker();
    return new EditorWorker();
  },
};

// JSON highlighting without the JSON language service (no worker).
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'], aliases: ['JSON'] });
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}[\],:]/, 'delimiter'],
    ],
    comment: [[/\*\//, 'comment', '@pop'], [/./, 'comment']],
  },
});
monaco.languages.setLanguageConfiguration('json', {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
});

loader.config({ monaco });

export { monaco };
