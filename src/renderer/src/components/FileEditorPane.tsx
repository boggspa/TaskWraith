import type { EditorStateConfig, Extension } from '@codemirror/state'
import CodeMirror from '@uiw/react-codemirror'
import type { EditorCursorStatus } from './FileEditorStatusBar'

export interface EditorPaneSelection {
  anchor: number
  head?: number
}

export interface EditorPaneProps {
  selectedPath: string
  content: string
  isLoading: boolean
  editorExtensions: Extension[]
  initialSelection?: EditorStateConfig['selection']
  onContentChange: (value: string) => void
}

export const FILE_EDITOR_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  rectangularSelection: false,
  crosshairCursor: false
} as const

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export const editorSelectionFromCursorStatus = (
  content: string,
  cursorStatus: EditorCursorStatus
): EditorPaneSelection => {
  const lines = content.split('\n')
  const lineNumber = clampNumber(cursorStatus.line, 1, Math.max(1, lines.length))
  let lineStart = 0
  for (let index = 0; index < lineNumber - 1; index += 1) {
    lineStart += (lines[index]?.length ?? 0) + 1
  }
  const line = lines[lineNumber - 1] ?? ''
  const column = clampNumber(cursorStatus.column, 1, line.length + 1)
  const head = lineStart + column - 1
  const selectedChars = clampNumber(cursorStatus.selectedChars, 0, content.length)
  if (selectedChars <= 0) return { anchor: head }
  return {
    anchor: Math.max(0, head - selectedChars),
    head
  }
}

export function EditorPane({
  selectedPath,
  content,
  isLoading,
  editorExtensions,
  initialSelection,
  onContentChange
}: EditorPaneProps) {
  return (
    <div className="file-editor-code-surface">
      {selectedPath ? (
        <CodeMirror
          key={selectedPath}
          value={content}
          height="100%"
          basicSetup={FILE_EDITOR_BASIC_SETUP}
          editable={!isLoading}
          readOnly={isLoading}
          extensions={editorExtensions}
          selection={initialSelection}
          onChange={onContentChange}
        />
      ) : (
        <div className="file-editor-placeholder">Select a text file</div>
      )}
    </div>
  )
}
