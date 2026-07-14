import { describe, expect, it } from 'vitest'
import {
  restoreQueuedRunWorktreeTarget,
  snapshotQueuedRunWorktreeTarget
} from './runRequestTypes'

describe('queued run worktree target', () => {
  it('survives durable JSON persistence and restart recovery unchanged', () => {
    const queued = snapshotQueuedRunWorktreeTarget('/repo-worktrees/feature-a/')
    const persisted = JSON.parse(JSON.stringify(queued)) as {
      effectiveWorkspacePath?: unknown
    }

    expect(restoreQueuedRunWorktreeTarget(persisted)).toBe('/repo-worktrees/feature-a')
  })

  it('does not invent a worktree target for a legacy queue row', () => {
    expect(restoreQueuedRunWorktreeTarget({})).toBeUndefined()
    expect(snapshotQueuedRunWorktreeTarget('')).toEqual({})
  })
})
