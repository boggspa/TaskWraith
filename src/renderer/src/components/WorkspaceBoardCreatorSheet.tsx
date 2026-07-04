import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { WorkspaceBoardCreateInput } from './Sidebar'

interface WorkspaceBoardCreatorSheetProps {
  open: boolean
  workspaces: WorkspaceRecord[]
  currentWorkspace: WorkspaceRecord | null
  onCreate: (input: WorkspaceBoardCreateInput) => void | Promise<void>
  onDismiss: () => void
}

export function WorkspaceBoardCreatorSheet({
  open,
  workspaces,
  currentWorkspace,
  onCreate,
  onDismiss
}: WorkspaceBoardCreatorSheetProps): React.JSX.Element | null {
  const initialWorkspace = currentWorkspace || workspaces[0] || null
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace?.id || '')
  const [boardName, setBoardName] = useState(
    initialWorkspace ? `${initialWorkspace.displayName} Board` : ''
  )

  useEffect(() => {
    if (!open) return
    const workspace = currentWorkspace || workspaces[0] || null
    setWorkspaceId(workspace?.id || '')
    setBoardName(workspace ? `${workspace.displayName} Board` : '')
  }, [currentWorkspace, open, workspaces])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, open])

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId) || initialWorkspace,
    [initialWorkspace, workspaceId, workspaces]
  )

  if (!open) return null

  const handleWorkspaceChange = (nextWorkspaceId: string): void => {
    const workspace = workspaces.find((item) => item.id === nextWorkspaceId) || null
    setWorkspaceId(nextWorkspaceId)
    if (workspace) setBoardName(`${workspace.displayName} Board`)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!selectedWorkspace) return
    void Promise.resolve(
      onCreate({
        workspaceId: selectedWorkspace.id,
        name: boardName.trim() || `${selectedWorkspace.displayName} Board`
      })
    ).catch((error) => {
      console.warn('[workspace board] failed to create board:', error)
    })
  }

  return (
    <div
      className="workspace-board-creator-sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div className="workspace-board-creator-sheet" role="dialog" aria-modal="true">
        <form className="sidebar-board-creator-form" onSubmit={handleSubmit}>
          <div className="sidebar-board-creator-title">New Workspace Board</div>
          <label
            className="sidebar-board-creator-field"
            htmlFor="workspace-board-creator-sheet-workspace"
          >
            <span>Workspace</span>
            <select
              id="workspace-board-creator-sheet-workspace"
              value={selectedWorkspace?.id || workspaceId}
              onChange={(event) => handleWorkspaceChange(event.target.value)}
              disabled={workspaces.length === 0}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.displayName}
                </option>
              ))}
            </select>
          </label>
          <label
            className="sidebar-board-creator-field"
            htmlFor="workspace-board-creator-sheet-name"
          >
            <span>Board name</span>
            <input
              id="workspace-board-creator-sheet-name"
              type="text"
              value={boardName}
              onChange={(event) => setBoardName(event.target.value)}
              placeholder={selectedWorkspace ? `${selectedWorkspace.displayName} Board` : 'Board'}
              autoFocus
            />
          </label>
          <div className="sidebar-board-creator-actions">
            <button type="button" onClick={onDismiss}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={workspaces.length === 0}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
