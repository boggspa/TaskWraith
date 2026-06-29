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
