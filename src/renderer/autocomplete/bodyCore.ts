import type { editor, languages, Position } from 'monaco-editor'
import { resolvePath } from '@shared/consoleParser'
import { jsonContextAt, type JsonCursorContext } from '@shared/jsonContext'
import type { FieldInfo } from '@shared/meta'
import { AGG_SNIPPETS, QUERY_SNIPPETS, ROOT_SNIPPETS, shapeSnippet } from '@shared/snippets'
import { bodySuggestions, matchEndpoint, type BodyWant, type Spec } from '@shared/specEngine'
import type { HttpMethod } from '@shared/types'
import { monaco } from '../monaco/setup'
import { decide, rankFor } from './bodyCompletion'
import specJson from './spec/es.json'

export const spec = specJson as unknown as Spec

export interface BodyContext {
  method: HttpMethod
  /** Request path as written (may omit the index when a default target applies). */
  path: string
  defaultTarget?: string
  fields(target: string): Promise<FieldInfo[]>
}

/** Placeholder words in our snippets; completing over one replaces it entirely. */
const PLACEHOLDER = /^(FIELD|VALUE|TEXT|PATH|QUERY|NAME|ID|REGEX|VALUE\*)(?=")/

/**
 * Completions for a JSON request body (both the workspace console and the index view editor).
 * `startLine` is the model line where the body begins.
 */
export async function bodyCompletions(model: editor.ITextModel, position: Position, startLine: number, ctx: BodyContext): Promise<languages.CompletionList> {
  const K = monaco.languages.CompletionItemKind
  const Rule = monaco.languages.CompletionItemInsertTextRule
  const path = resolvePath(ctx.path, ctx.defaultTarget)
  const before = model.getValueInRange({ startLineNumber: startLine, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
  const jc = jsonContextAt(before)
  const endpoint = matchEndpoint(spec, ctx.method, path)
  const want: BodyWant = endpoint?.endpoint.b ? bodySuggestions(spec, endpoint.endpoint.b, jc) : fallback(jc)
  if (!want) return { suggestions: [] }

  // Replace range. Inside a string, the rest of the word after the cursor is replaced too. When the
  // closing quote is already there (and, for keys, the colon), only the word inside the quotes is
  // replaced: the edit then stays inside snippet placeholders (FIELD, VALUE…) so Tab keeps working.
  const line = model.getLineContent(position.lineNumber)
  const after = line.slice(position.column - 1)
  let endCol = position.column
  let keepQuote = false
  let colonFollows = false
  if (jc.inString) {
    const m = /^[\w.@*-]*(?=")/.exec(after)
    const tokenLen = m ? m[0].length : 0
    if (after[tokenLen] === '"') {
      colonFollows = /^\s*:/.test(after.slice(tokenLen + 1))
      keepQuote = jc.position === 'value' || colonFollows
      endCol += tokenLen + (keepQuote ? 0 : 1)
    }
  }
  const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column - jc.partial.length, endColumn: endCol }
  // Every item should match a selected placeholder word, so filter texts are prefixed with it.
  const placeholder = jc.inString && PLACEHOLDER.test(`${jc.partial}"`) ? jc.partial : ''
  const keyText = (name: string) => (keepQuote ? name : (jc.inString ? `${name}"` : `"${name}"`) + (colonFollows ? '' : ': '))
  const valueText = (name: string, raw = false) => (raw ? name : keepQuote ? name : jc.inString ? `${name}"` : `"${name}"`)
  const retrigger = { id: 'editor.action.triggerSuggest', title: 'Suggest' }

  if (want.kind === 'keys') {
    return {
      suggestions: want.keys.map((k, i) => {
        const shape = want.shapes?.[k]
        const template = colonFollows ? undefined : (want.container === 'query' ? QUERY_SNIPPETS[k] : want.container === 'agg' ? AGG_SNIPPETS[k] : want.container === 'root' ? ROOT_SNIPPETS[k] : undefined) ?? shapeSnippet(shape?.shape, shape?.values)
        return {
          label: { label: k, description: shape && shape.shape !== 'any' ? shape.shape : undefined },
          kind: want.container === 'query' || want.container === 'agg' ? K.Struct : K.Property,
          insertText: template ? keyText(k) + template : keyText(k),
          insertTextRules: template ? Rule.InsertAsSnippet : undefined,
          range,
          sortText: `${want.container === 'root' && k in ROOT_SNIPPETS ? 0 : 1}${String(i).padStart(3, '0')}`,
          // Templates with a FIELD slot open field suggestions right away.
          command: template?.includes('${1:FIELD}') || template === '{\n\t$0\n}' || template === '[\n\t$0\n]' ? retrigger : undefined
        }
      })
    }
  }
  if (want.kind === 'values') {
    return { suggestions: want.values.map((v) => ({ label: v, kind: K.EnumMember, insertText: valueText(v, v === 'true' || v === 'false'), filterText: placeholder + v, range })) }
  }

  const target = path.split(/[/?]/)[0] ?? ''
  const fieldTarget = target && !target.startsWith('_') ? target : ctx.defaultTarget
  if (!fieldTarget) return { suggestions: [] }
  const fields = (await ctx.fields(fieldTarget)).filter((f) => f.type !== 'object' && f.type !== 'nested')
  const rank = rankFor(jc)
  return {
    suggestions: fields.map((f) => ({
      label: { label: f.path, description: f.type },
      kind: K.Field,
      detail: `${f.type} · ${fieldTarget}`,
      insertText: jc.position === 'key' ? keyText(f.path) : valueText(f.path),
      filterText: placeholder + f.path,
      range,
      sortText: `${rank(f)}${f.path}`
    }))
  }
}

/** Endpoints without a body type in the spec fall back to the hand-written DSL hints. */
function fallback(jc: JsonCursorContext): BodyWant {
  const d = decide(jc)
  if (!d) return null
  return d.kind === 'fields' ? { kind: 'fields' } : { kind: 'keys', keys: d.keys, container: jc.path.length === 0 ? 'root' : 'other' }
}
