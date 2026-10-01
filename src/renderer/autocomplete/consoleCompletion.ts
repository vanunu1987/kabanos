import type { editor, languages, Position } from 'monaco-editor'
import type { FieldInfo } from '@shared/meta'
import { pathSuggestions, type Names } from '@shared/specEngine'
import type { HttpMethod } from '@shared/types'
import { monaco } from '../monaco/setup'
import { bodyCompletions, spec } from './bodyCore'
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']

/** What a block editor knows about its surroundings, registered per Monaco model URI. */
export interface ConsoleContext {
  names(): Names
  fields(target: string): Promise<FieldInfo[]>
  defaultTarget(): string | undefined
}
const contexts = new Map<string, ConsoleContext>()

export function registerConsoleContext(modelUri: string, ctx: ConsoleContext): () => void {
  contexts.set(modelUri, ctx)
  return () => contexts.delete(modelUri)
}

export const CONSOLE_LANGUAGE = 'kabanos-console'
let registered = false

/** Kibana-console language: `METHOD path` on the first line, a JSON body below, {{vars}} and comments. */
export function ensureConsoleLanguage(): void {
  if (registered) return
  registered = true
  monaco.languages.register({ id: CONSOLE_LANGUAGE })
  monaco.languages.setLanguageConfiguration(CONSOLE_LANGUAGE, {
    comments: { lineComment: '//' },
    brackets: [
      ['{', '}'],
      ['[', ']']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' }
    ],
    folding: { markers: { start: /^\s*[{[]\s*$/, end: /^\s*[}\]]/ } }
  })
  monaco.languages.setMonarchTokensProvider(CONSOLE_LANGUAGE, {
    defaultToken: '',
    tokenPostfix: '',
    tokenizer: {
      root: [
        [/^(GET)(\s+)/, ['method.get', '']],
        [/^(POST)(\s+)/, ['method.post', '']],
        [/^(PUT|PATCH)(\s+)/, ['method.put', '']],
        [/^(HEAD)(\s+)/, ['method.head', '']],
        [/^(DELETE)(\s+)/, ['method.delete', '']],
        [/\{\{[\w.-]+\}\}/, 'variable'],
        [/(\/\/|#).*$/, 'comment'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
        [/"""/, { token: 'value', next: '@triple' }],
        [/"/, { token: 'value', next: '@string' }],
        [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'num'],
        [/\b(true|false|null)\b/, 'literal'],
        [/[{}[\],:]/, 'delimiter'],
        [/[^\s{}[\],:"]+/, 'path']
      ],
      string: [
        [/\{\{[\w.-]+\}\}/, 'variable'],
        [/[^\\"{]+/, 'value'],
        [/\\./, 'value'],
        [/\{/, 'value'],
        [/"/, { token: 'value', next: '@pop' }]
      ],
      triple: [
        [/"""/, { token: 'value', next: '@pop' }],
        [/./, 'value']
      ]
    }
  })

  monaco.languages.registerCompletionItemProvider(CONSOLE_LANGUAGE, {
    triggerCharacters: ['"', '/', '?', '&', ' ', '_'],
    async provideCompletionItems(model: editor.ITextModel, position: Position): Promise<languages.CompletionList> {
      const ctx = contexts.get(model.uri.toString())
      const K = monaco.languages.CompletionItemKind
      const first = model.getLineContent(1)
      const m = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\b\s*(.*)$/i.exec(first)

      // ---- request line ----
      if (position.lineNumber === 1) {
        const before = first.slice(0, position.column - 1)
        if (!/\s/.test(before.trim()) && !/\s$/.test(before)) {
          const word = before.trim()
          return {
            suggestions: METHODS.map((meth, i) => ({
              label: meth,
              kind: K.Keyword,
              insertText: `${meth} `,
              range: { startLineNumber: 1, endLineNumber: 1, startColumn: position.column - word.length, endColumn: position.column },
              sortText: String(i),
              command: { id: 'editor.action.triggerSuggest', title: '' }
            }))
          }
        }
        if (!m || !ctx) return { suggestions: [] }
        const method = m[1]!.toUpperCase() as HttpMethod
        const typed = before.replace(/^\s*\w+\s+/, '')
        const partial = /[^/?&=]*$/.exec(typed)?.[0] ?? ''
        const range = { startLineNumber: 1, endLineNumber: 1, startColumn: position.column - partial.length, endColumn: position.column }
        const items = pathSuggestions(spec, method, typed, ctx.names())
        const kindOf = { endpoint: K.Function, index: K.Folder, alias: K.Reference, datastream: K.Module, param: K.Property, segment: K.Text } as const
        return {
          suggestions: items.map((s) => ({
            label: { label: s.label, description: s.kind === 'endpoint' ? s.detail : s.kind },
            kind: kindOf[s.kind],
            insertText: s.kind === 'param' ? `${s.insert}=` : s.insert,
            range,
            sortText: `${s.kind === 'index' || s.kind === 'alias' || s.kind === 'datastream' ? 0 : s.kind === 'param' ? 1 : 2}${s.label}`
          }))
        }
      }

      // ---- body ----
      if (!m || !ctx) return { suggestions: [] }
      return bodyCompletions(model, position, 2, { method: m[1]!.toUpperCase() as HttpMethod, path: m[2]!.trim(), defaultTarget: ctx.defaultTarget(), fields: (t) => ctx.fields(t) })
    }
  })
}
