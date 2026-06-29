export interface FileEditorGitActionsProps {
  workspacePath?: string
  selectedPath: string
  isDirty: boolean
  isLoading: boolean
  selectedHasUnstagedChanges: boolean
  selectedHasStagedChanges: boolean
  stagedCount: number
  outOfScopeStagedCount: number
  dirtyBufferCount: number
  lineWrapEnabled: boolean
  onDeleteRequest: () => void
  onStage: () => void | Promise<void>
  onUnstage: () => void | Promise<void>
  onCommitRequest: () => void
  onSaveAll: () => void | Promise<void>
  onSave: () => void | Promise<void>
  onReloadSelected: () => void | Promise<void>
  onToggleLineWrap: () => void
  onOpenQuickOpen: () => void
  onRevealInTree: () => void | Promise<void>
}

export function FileEditorGitActions({
  workspacePath,
  selectedPath,
  isDirty,
  isLoading,
  selectedHasUnstagedChanges,
  selectedHasStagedChanges,
  stagedCount,
  outOfScopeStagedCount,
  dirtyBufferCount,
  lineWrapEnabled,
  onDeleteRequest,
  onStage,
  onUnstage,
  onCommitRequest,
  onSaveAll,
  onSave,
  onReloadSelected,
  onToggleLineWrap,
  onOpenQuickOpen,
  onRevealInTree
}: FileEditorGitActionsProps) {
  const commitDisabled =
    !workspacePath || stagedCount === 0 || outOfScopeStagedCount > 0 || isLoading
  const commitTitle =
    outOfScopeStagedCount > 0
      ? `${outOfScopeStagedCount} staged ${
          outOfScopeStagedCount === 1 ? 'file is' : 'files are'
        } outside this workspace`
      : stagedCount > 0
        ? `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`
        : 'No staged files'

  return (
    <div className="file-editor-actions">
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={onDeleteRequest}
        disabled={!workspacePath || !selectedPath || isDirty || isLoading}
        aria-label="Delete editor file"
        title={isDirty ? 'Save or discard changes before deleting' : 'Delete editor file'}
      >
        Delete
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={() => void onStage()}
        disabled={
          !workspacePath || !selectedPath || isDirty || isLoading || !selectedHasUnstagedChanges
        }
        aria-label="Stage editor file"
        title={isDirty ? 'Save before staging this file' : 'Stage editor file'}
      >
        Stage
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={() => void onUnstage()}
        disabled={!workspacePath || !selectedPath || isLoading || !selectedHasStagedChanges}
        aria-label="Unstage editor file"
        title="Unstage editor file"
      >
        Unstage
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={onCommitRequest}
        disabled={commitDisabled}
        aria-label="Commit staged changes"
        title={commitTitle}
      >
        Commit
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={() => void onReloadSelected()}
        disabled={!workspacePath || !selectedPath || isLoading}
        aria-label="Reload editor file from disk"
        title={
          isDirty
            ? 'Reload from disk and discard unsaved changes'
            : 'Reload editor file from disk'
        }
      >
        Reload
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={() => void onRevealInTree()}
        disabled={!workspacePath || !selectedPath || isLoading}
        title="Reveal selected file in tree"
      >
        Reveal
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={onOpenQuickOpen}
        disabled={!workspacePath || isLoading}
        title="Quick open file"
      >
        Quick Open
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={onToggleLineWrap}
        aria-pressed={lineWrapEnabled}
        title={lineWrapEnabled ? 'Turn line wrap off' : 'Turn line wrap on'}
      >
        Wrap
      </button>
      <button
        className="btn btn-sm btn-ghost"
        type="button"
        onClick={() => void onSaveAll()}
        disabled={!workspacePath || dirtyBufferCount === 0 || isLoading}
        aria-label="Save all open editor files"
        title={
          dirtyBufferCount > 0
            ? `Save ${dirtyBufferCount} dirty file${dirtyBufferCount === 1 ? '' : 's'}`
            : 'No dirty files'
        }
      >
        Save All
      </button>
      <button
        className="btn btn-sm"
        type="button"
        onClick={() => void onSave()}
        disabled={!workspacePath || !selectedPath || !isDirty || isLoading}
        aria-label="Save editor file"
        title="Save editor file"
      >
        Save
      </button>
    </div>
  )
}
