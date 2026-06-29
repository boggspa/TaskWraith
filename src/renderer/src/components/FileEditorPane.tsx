import type { Extension } from '@codemirror/state'
import CodeMirror from '@uiw/react-codemirror'

export interface EditorPaneProps {
  selectedPath: string
  content: string
  isLoading: boolean
  editorExtensions: Extension[]
  onContentChange: (value: string) => void
}

export function EditorPane({
  selectedPath,
  content,
  isLoading,
  editorExtensions,
  onContentChange
}: EditorPaneProps) {
  return (
    <div className="file-editor-code-surface">
      {selectedPath ? (
        <CodeMirror
          key={selectedPath}
          value={content}
          height="100%"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            rectangularSelection: false,
            crosshairCursor: false
          }}
          editable={!isLoading}
          readOnly={isLoading}
          extensions={editorExtensions}
          onChange={onContentChange}
        />
      ) : (
        <div className="file-editor-placeholder">Select a text file</div>
      )}
    </div>
  )
}
