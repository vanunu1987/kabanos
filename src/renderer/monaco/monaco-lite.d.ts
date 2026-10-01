// The trimmed entry exposes the same API as monaco-editor (minus css/html/typescript namespaces).
import type * as Monaco from 'monaco-editor'
export const editor: typeof Monaco.editor
export const languages: typeof Monaco.languages
export const json: typeof Monaco.json
export const Uri: typeof Monaco.Uri
export const KeyCode: typeof Monaco.KeyCode
export const KeyMod: typeof Monaco.KeyMod
export const Range: typeof Monaco.Range
export const Position: typeof Monaco.Position
export const Selection: typeof Monaco.Selection
export const MarkerSeverity: typeof Monaco.MarkerSeverity
