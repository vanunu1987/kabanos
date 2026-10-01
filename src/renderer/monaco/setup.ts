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

// SPEC §10 tokens, dark and light.
const rules = (c: Record<string, string>) => [
  { token: 'string.key.json', foreground: c.key },
  { token: 'string.value.json', foreground: c.str },
  { token: 'number', foreground: c.num },
  { token: 'number.json', foreground: c.num },
  { token: 'keyword.json', foreground: c.lit },
  { token: 'delimiter', foreground: c.punct },
  { token: 'comment', foreground: c.comment, fontStyle: 'italic' },
  { token: 'method.get', foreground: c.get, fontStyle: 'bold' },
  { token: 'method.post', foreground: c.post, fontStyle: 'bold' },
  { token: 'method.put', foreground: c.put, fontStyle: 'bold' },
  { token: 'method.head', foreground: c.head, fontStyle: 'bold' },
  { token: 'method.delete', foreground: c.del, fontStyle: 'bold' },
  { token: 'path', foreground: c.text },
  { token: 'title', foreground: c.text2, fontStyle: 'bold' },
  { token: 'variable', foreground: c.os, fontStyle: 'bold' },
  { token: 'key', foreground: c.key },
  { token: 'value', foreground: c.str },
  { token: 'num', foreground: c.num },
  { token: 'literal', foreground: c.lit }
]

monaco.editor.defineTheme('kabanos-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: rules({ key: '9CC4FF', str: 'E7C58B', num: 'C7A2FF', lit: 'FF9E7A', punct: '7C8595', comment: '6B7385', get: '5CCB8A', post: 'F2B544', put: '6AA8FF', head: 'B6A2FF', del: 'FF7A70', text: 'E6E8EC', text2: 'C9CFD9', os: '4DC4D6' }),
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
    'editorSuggestWidget.foreground': '#C9CFD9',
    'editorSuggestWidget.selectedBackground': '#2B2512',
    'editorSuggestWidget.selectedForeground': '#E6E8EC',
    'editorSuggestWidget.selectedIconForeground': '#F2B544',
    'editorSuggestWidget.highlightForeground': '#F2B544',
    'editorSuggestWidget.focusHighlightForeground': '#FFD27A',
    'list.hoverBackground': '#232832',
    'scrollbarSlider.background': '#2A2F3966'
  }
})

monaco.editor.defineTheme('kabanos-light', {
  base: 'vs',
  inherit: true,
  rules: rules({ key: '2C6BD3', str: '9A5F05', num: '7448CC', lit: 'BF5419', punct: '6B7380', comment: '8A93A1', get: '1B8A52', post: 'B5770A', put: '2C6BD3', head: '7554D1', del: 'CC3D32', text: '1A1D23', text2: '353C49', os: '0B8496' }),
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#353C49',
    'editorLineNumber.foreground': '#A6ADB9',
    'editorLineNumber.activeForeground': '#5B6472',
    'editor.lineHighlightBackground': '#F3F4F7',
    'editor.selectionBackground': '#D6E2F7',
    'editorCursor.foreground': '#B5770A',
    'editorIndentGuide.background1': '#E8EBF0',
    'editorWidget.background': '#FFFFFF',
    'editorWidget.border': '#CFD4DC',
    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.border': '#CFD4DC',
    // Explicit row colors: Monaco's defaults give light text on the pale selection background.
    'editorSuggestWidget.foreground': '#353C49',
    'editorSuggestWidget.selectedBackground': '#FCEBCB',
    'editorSuggestWidget.selectedForeground': '#1A1D23',
    'editorSuggestWidget.selectedIconForeground': '#965F04',
    'editorSuggestWidget.highlightForeground': '#965F04',
    'editorSuggestWidget.focusHighlightForeground': '#7A4D00',
    'list.hoverBackground': '#F3F4F7',
    'list.hoverForeground': '#1A1D23',
    'editorHoverWidget.background': '#FFFFFF',
    'editorHoverWidget.foreground': '#353C49',
    'editorHoverWidget.border': '#CFD4DC',
    'scrollbarSlider.background': '#B7BDC855'
  }
})

monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', schemas: [] })

export { monaco }
