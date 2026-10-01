import Editor from '@monaco-editor/react'
import { useEffect, useRef, useState } from 'react'
import { CONSOLE_LANGUAGE, ensureConsoleLanguage, registerConsoleContext, type ConsoleContext } from '../../autocomplete/consoleCompletion'
import '../../monaco/setup'
import { useWorkspace } from './store'
import { formatBlock } from '@shared/format'
import { useMonacoTheme } from '../../theme/theme'

const LINE = 21
const MAX_HEIGHT = 560

/** One request block: Monaco in the Kibana-console language, growing with its content. */
export function ConsoleEditor({ id, value, onChange, onRun, onFocus, context, autoFocus }: { id: string; value: string; onChange(v: string): void; onRun(): void; onFocus?(): void; context: ConsoleContext; autoFocus?: boolean }) {
  const [height, setHeight] = useState(Math.min(MAX_HEIGHT, Math.max(3, value.split('\n').length) * LINE + 20))
  const runRef = useRef(onRun)
  runRef.current = onRun
  const ctxRef = useRef(context)
  ctxRef.current = context
  const uri = `block://${id}`
  const theme = useMonacoTheme()

  useEffect(() => {
    ensureConsoleLanguage()
    return registerConsoleContext(uri, {
      names: () => ctxRef.current.names(),
      fields: (t) => ctxRef.current.fields(t),
      defaultTarget: () => ctxRef.current.defaultTarget()
    })
  }, [uri])

  return (
    <div style={{ height }} className="console-editor">
      <Editor
        height="100%"
        theme={theme}
        language={CONSOLE_LANGUAGE}
        path={uri}
        value={value}
        beforeMount={() => ensureConsoleLanguage()}
        onChange={(v) => onChange(v ?? '')}
        options={{
          fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
          fontSize: 12.5,
          lineHeight: LINE,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 10, bottom: 10 },
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
          fixedOverflowWidgets: true,
          quickSuggestions: { strings: true, other: true, comments: false },
          wordBasedSuggestions: 'off',
          renderLineHighlight: 'line',
          stickyScroll: { enabled: false },
          overviewRulerLanes: 0,
          lineNumbersMinChars: 3
        }}
        onMount={(ed, m) => {
          // addAction (not addCommand): commands are shared across editors, so the last block's handler won.
          ed.addAction({ id: 'kabanos.run', label: 'Run request', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], run: () => runRef.current() })
          // ⌘I auto-indent, like Kibana's console (undoable edit, cursor line kept).
          ed.addAction({
            id: 'kabanos.format',
            label: 'Auto-indent request',
            keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyI],
            contextMenuGroupId: 'modification',
            run: (editor) => {
              const model = editor.getModel()
              if (!model) return
              const next = formatBlock(model.getValue())
              if (next === model.getValue()) return
              const line = editor.getPosition()?.lineNumber ?? 1
              editor.pushUndoStop()
              editor.executeEdits('kabanos.format', [{ range: model.getFullModelRange(), text: next }])
              editor.pushUndoStop()
              editor.setPosition({ lineNumber: Math.min(line, model.getLineCount()), column: model.getLineMaxColumn(Math.min(line, model.getLineCount())) })
            }
          })
          ed.onDidFocusEditorText(() => onFocus?.())
          ed.onDidContentSizeChange((e) => setHeight(Math.min(MAX_HEIGHT, Math.max(3 * LINE + 20, e.contentHeight))))
          if (autoFocus) {
            useWorkspace.setState({ focusBlock: undefined })
            ed.focus()
            ed.setPosition({ lineNumber: 1, column: (ed.getModel()?.getLineContent(1).length ?? 0) + 1 })
          }
        }}
      />
    </div>
  )
}
