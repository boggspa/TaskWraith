import type { ReactNode } from 'react'
import { decodeSidebarGitIndicators } from '../lib/sidebarGitIndicators'
import { SidebarGitIndicatorStrip } from './SidebarGitIndicatorStrip'
import { branchTone } from './GitStatusChips'

/**
 * Active-row title ticker: the selected row's label slowly slides between the
 * thread title and its workspace/branch identity ("TaskWraith/master"). Pure
 * CSS (see 01-sidebar.css `.sidebar-title-ticker*`): two 100%-width
 * ellipsizing segments in an overflow-hidden strip, ease-in-out holds,
 * disabled under prefers-reduced-motion. Rename editing bypasses the ticker
 * at the call sites so double-click-to-rename keeps working.
 */
export function SidebarTitleTicker({
  identity,
  branch,
  gitIndicators,
  className,
  children
}: {
  identity: string
  /** The branch half of `identity`, supplied separately rather than split out
   * of it: a branch may itself contain "/" ("feat/foo"), and so may a
   * folder-derived workspace name, so there is no safe place to cut the joined
   * string. Absent (no repo / detached) leaves the whole face untinted. */
  branch?: string | null
  /** Encoded git status strip (see lib/sidebarGitIndicators). Rides the
   * identity face, right-aligned, so it slides in and out with the branch
   * name rather than becoming permanent row chrome. */
  gitIndicators?: string | null
  className: string
  children: ReactNode
}): ReactNode {
  const indicators = decodeSidebarGitIndicators(gitIndicators)
  // Only the branch is tinted; the repo/workspace name stays in the row's own
  // ink. The suffix check is belt-and-braces — if the two ever disagree the
  // face renders plain rather than mis-slicing the name.
  const trimmedBranch = (branch || '').trim()
  const branchSuffix = trimmedBranch ? `/${trimmedBranch}` : ''
  const splitsCleanly = Boolean(branchSuffix) && identity.endsWith(branchSuffix)
  const repoHalf = splitsCleanly ? identity.slice(0, identity.length - trimmedBranch.length) : ''
  return (
    <span className={`sidebar-title-ticker ${className}`}>
      <span className="sidebar-title-ticker-strip">
        <span className="sidebar-title-ticker-seg">{children}</span>
        <span className="sidebar-title-ticker-seg sidebar-title-ticker-identity" aria-hidden>
          <span className="sidebar-title-ticker-identity-text">
            {splitsCleanly ? (
              <>
                {repoHalf}
                <span
                  className={`sidebar-title-ticker-branch git-tone-${branchTone(
                    trimmedBranch,
                    false
                  )}`}
                >
                  {trimmedBranch}
                </span>
              </>
            ) : (
              identity
            )}
          </span>
          <SidebarGitIndicatorStrip indicators={indicators} />
        </span>
      </span>
    </span>
  )
}
