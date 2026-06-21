import type { LaunchTargetsSnapshot } from '../../../main/launchTargets/types'
import { useWorkspaceLaunchTargets } from './useWorkspaceLaunchTargets'

export function useLaunchTargets(workspacePath: string | null | undefined): {
  snapshot: LaunchTargetsSnapshot | null
  targets: LaunchTargetsSnapshot['targets']
  busy: boolean
  error: string | null
  refresh: () => Promise<LaunchTargetsSnapshot | null>
} {
  const launchTargets = useWorkspaceLaunchTargets([workspacePath])

  return {
    snapshot: launchTargets.snapshotForWorkspace(workspacePath),
    targets: launchTargets.targetsForWorkspace(workspacePath),
    busy: launchTargets.busy,
    error: launchTargets.errorForWorkspace(workspacePath),
    refresh: () => launchTargets.refresh(workspacePath)
  }
}
