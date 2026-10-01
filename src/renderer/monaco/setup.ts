import { loader } from '@monaco-editor/react'
import * as monaco from './monaco-lite'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'

// Monaco is bundled locally (never from a CDN) and its workers ship with the app.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker())
}
// The full monaco-editor type is what @monaco-editor/react expects; the lite build is API-compatible.
loader.config({ monaco: monaco as unknown as typeof import('monaco-editor') })

// SPEC §10 tokens.
monaco.editor.defineTheme('kabanos', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '9CC4FF' },
    { token: 'string.value.json', foreground: 'E7C58B' },
    { token: 'number', foreground: 'C7A2FF' },
    { token: 'number.json', foreground: 'C7A2FF' },
    { token: 'keyword.json', foreground: 'FF9E7A' },
    { token: 'delimiter', foreground: '7C8595' },
    { token: 'comment', foreground: '6B7385', fontStyle: 'italic' },
    { token: 'method.get', foreground: '5CCB8A', fontStyle: 'bold' },
    { token: 'method.post', foreground: 'F2B544', fontStyle: 'bold' },
    { token: 'method.put', foreground: '6AA8FF', fontStyle: 'bold' },
    { token: 'method.head', foreground: 'B6A2FF', fontStyle: 'bold' },
    { token: 'method.delete', foreground: 'FF7A70', fontStyle: 'bold' },
    { token: 'path', foreground: 'E6E8EC' },
    { token: 'title', foreground: 'C9CFD9', fontStyle: 'bold' },
    { token: 'variable', foreground: '4DC4D6', fontStyle: 'bold' },
    { token: 'key', foreground: '9CC4FF' },
    { token: 'value', foreground: 'E7C58B' },
    { token: 'num', foreground: 'C7A2FF' },
    { token: 'literal', foreground: 'FF9E7A' }
  ],
  colors: {
    'editor.background': '#121419',
    'editor.foreground': '#C9CFD9',
    'editorLineNumber.foreground': '#4E5563',
    'editorLineNumber.activeForeground': '#9AA3B2',
    'editor.lineHighlightBackground': '#191C22',
    'editor.selectionBackground': '#2B3442',
    'editorCursor.foreground': '#F2B544',
    'editorIndentGuide.background1': '#20242C',
    'editorWidget.background': '#1D2027',
    'editorWidget.border': '#3A3F49',
    'editorSuggestWidget.background': '#1D2027',
    'editorSuggestWidget.border': '#3A3F49',
    'editorSuggestWidget.selectedBackground': '#2B2512',
    'editorSuggestWidget.highlightForeground': '#F2B544',
    'scrollbarSlider.background': '#2A2F3966'
  }
})

monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', schemas: [] })

export { monaco }
