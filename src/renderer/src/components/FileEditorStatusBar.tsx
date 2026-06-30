import type { GitFileStatus } from '../../../main/services/GitService'
import { formatBytes } from './FileEditorUtils'

export interface EditorCursorStatus {
  line: number
  column: number
  selectedChars: number
}

export interface FileEditorStatusBuffer {
  path: string
  sizeBytes: number
}

export interface FileEditorStatusBarProps {
  activeBuffer: FileEditorStatusBuffer | null
  isDirty: boolean
  status: string
  gitMessage: string
  cursorStatus: EditorCursorStatus
  selectedGitFile?: GitFileStatus
  selectedHasStagedChanges: boolean
  selectedHasUnstagedChanges: boolean
  lineWrapEnabled: boolean
}

export const fileEditorLanguageLabel = (filePath: string): string => {
  const lower = filePath.toLowerCase()
  if (/\.(tsx|jsx)$/.test(lower)) return lower.endsWith('.tsx') ? 'TSX' : 'JSX'
  if (/\.(ts|mts|cts)$/.test(lower)) return 'TypeScript'
  if (/\.(js|mjs|cjs)$/.test(lower)) return 'JavaScript'
  if (/\.py$/.test(lower)) return 'Python'
  if (/\.(md|markdown)$/.test(lower)) return 'Markdown'
  if (/\.jsonc$/.test(lower)) return 'JSONC'
  if (/\.json$/.test(lower)) return 'JSON'
  if (/\.(html|htm)$/.test(lower)) return 'HTML'
  if (/\.(xml|svg)$/.test(lower)) return 'XML'
  if (/\.(css|scss|sass|less)$/.test(lower)) return 'CSS'
  if (/\.swift$/.test(lower)) return 'Swift'
  if (/\.(c|h|cc|cpp|cxx|hpp|hh|m|mm|metal)$/.test(lower)) return 'C/C++'
  if (
    /\.(sh|bash|zsh|fish|command|env)$/.test(lower) ||
    /(^|\/)(bashrc|zshrc|profile|env)$/.test(lower)
  ) {
    return 'Shell'
  }
  return 'Plain Text'
}

export function FileEditorStatusBar({
  activeBuffer,
  isDirty,
  status,
  gitMessage,
  cursorStatus,
  selectedGitFile,
  selectedHasStagedChanges,
  selectedHasUnstagedChanges,
  lineWrapEnabled
}: FileEditorStatusBarProps) {
  return (
    <div className="file-editor-status">
      <span role="status" aria-live="polite">
        {isDirty ? 'Unsaved changes' : status}
        {!isDirty && gitMessage ? ` · ${gitMessage}` : ''}
      </span>
      <span className="file-editor-status-spacer" aria-hidden="true" />
      {activeBuffer && (
        <>
          <span title={activeBuffer.path}>{activeBuffer.path}</span>
          <span>{fileEditorLanguageLabel(activeBuffer.path)}</span>
          <span>{formatBytes(activeBuffer.sizeBytes)}</span>
          <span>
            Ln {cursorStatus.line}, Col {cursorStatus.column}
            {cursorStatus.selectedChars > 0 ? ` · ${cursorStatus.selectedChars} selected` : ''}
          </span>
          <span>{lineWrapEnabled ? 'Wrap' : 'No wrap'}</span>
          {selectedGitFile && (
            <span>
              {selectedHasStagedChanges && selectedHasUnstagedChanges
                ? 'staged + unstaged'
                : selectedHasStagedChanges
                  ? 'staged'
                  : selectedHasUnstagedChanges
                    ? 'unstaged'
                    : selectedGitFile.kind}
            </span>
          )}
        </>
      )}
    </div>
  )
}
