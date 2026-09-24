import type { ComposerStyle } from '../../../main/store/types'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { ComposerBranchWorktreePopover } from './ComposerBranchWorktreePopover'
import type { ComposerWorktreeSelection } from '../lib/composerWorktreeSelection'

export interface ComposerWelcomeBranchPickerProps {
  workspacePath: string | null | undefined
  gitSnapshot: GitRepositorySnapshot | null | undefined
  fallbackBranch?: string
  detached?: boolean
  composerStyle: ComposerStyle
  composerWorktreeSelection?: ComposerWorktreeSelection | null
  onSnapshotRefresh?: (snapshot: GitRepositorySnapshot | null) => void
  onWorktreeSelectionChange?: (
    selection: ComposerWorktreeSelection | null,
    snapshot: GitRepositorySnapshot | null
  ) => void
}

/**
 * Branch / worktree picker for the welcome (new-thread) screen, rendered in the
 * telemetry row's right zone while the token / cost / RAM tally that normally
 * owns it has nothing to show. `shouldShowComposerWelcomeBranchPicker` decides
 * placement; this only draws it.
 *
 * The workspace name is deliberately omitted — the workspace switcher already
 * sits in the same row's LEFT zone, so repeating it here would say it twice.
 * Everything else is the same `ComposerBranchWorktreePopover` the workspace
 * above-row uses in an active thread, so checkout / new-branch / new-worktree
 * behave identically before and after the first turn.
 */
export function ComposerWelcomeBranchPicker({
  workspacePath,
  gitSnapshot,
  fallbackBranch,
  detached = false,
  composerStyle,
  composerWorktreeSelection,
  onSnapshotRefresh,
  onWorktreeSelectionChange
}: ComposerWelcomeBranchPickerProps): React.JSX.Element {
  return (
    <span className="composer-welcome-branch-picker" data-composer-control="welcome-branch">
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="4" cy="3.5" r="1.6" />
        <circle cx="4" cy="12.5" r="1.6" />
        <circle cx="12" cy="7" r="1.6" />
        <path d="M4 5.1v5.8M5.6 7c2 0 4.8 0 4.8-1.5" />
      </svg>
      <ComposerBranchWorktreePopover
        workspacePath={workspacePath}
        gitSnapshot={gitSnapshot}
        fallbackBranch={fallbackBranch}
        detached={detached}
        composerStyle={composerStyle}
        composerWorktreeSelection={composerWorktreeSelection}
        onSnapshotRefresh={onSnapshotRefresh}
        onWorktreeSelectionChange={onWorktreeSelectionChange}
      />
    </span>
  )
}
