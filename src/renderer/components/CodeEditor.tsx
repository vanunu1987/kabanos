import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useRef } from 'react'
import '../monaco/setup'
import { formatBody } from '@shared/format'

const OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
  fontSize: 12.5,
  lineHeight: 21,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  tabSize: 2,
  automaticLayout: true,
  padding: { top: 10, bottom: 10 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  fixedOverflowWidgets: true,
  quickSuggestions: { strings: true, other: true, comments: false },
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: 'off',
  stickyScroll: { enabled: false }
}

export interface CodeEditorProps {
  value: string
  onChange?(v: string): void
  language?: string
  readOnly?: boolean
  /** Monaco model path — lets completion providers know which editor they serve (e.g. `body://<conn>/<target>`). */
  path?: string
  onMount?: OnMount
  /** Cmd/Ctrl+Enter. */
  onRun?(): void
  height?: string | number
  options?: editor.IStandaloneEditorConstructionOptions
}

export function CodeEditor({ value, onChange, language = 'json', readOnly, path, onMount, onRun, height = '100%', options }: CodeEditorProps) {
  const runRef = useRef(onRun)
  runRef.current = onRun
  return (
    <Editor
      height={height}
      theme="kabanos"
      language={language}
      path={path}
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      options={{ ...OPTIONS, readOnly, ...options }}
      onMount={(ed, m) => {
        // addAction is scoped to this editor; addCommand keybindings collide between editors.
        ed.addAction({ id: 'kabanos.run', label: 'Run', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], run: () => runRef.current?.() })
        if (language === 'json' && !readOnly) {
          ed.addAction({
            id: 'kabanos.format',
            label: 'Auto-indent',
            keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyI],
            contextMenuGroupId: 'modification',
            run: (editor) => {
              const model = editor.getModel()
              if (!model) return
              const next = formatBody(model.getValue())
              if (!next || next === model.getValue()) return
              editor.pushUndoStop()
              editor.executeEdits('kabanos.format', [{ range: model.getFullModelRange(), text: next }])
              editor.pushUndoStop()
            }
          })
        }
        onMount?.(ed, m)
      }}
    />
  )
}

export function JsonDiff({ original, modified }: { original: string; modified: string }) {
  return <DiffEditor height="100%" theme="kabanos" language="json" original={original} modified={modified} options={{ ...OPTIONS, readOnly: true, renderSideBySide: false }} />
}
