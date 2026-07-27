import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceActivitySnapshot } from './store/types'
import {
  getCachedWorkspaceActivitySnapshot,
  resetWorkspaceActivityBackgroundForTests,
  setWorkspaceActivityScanDriver,
  setWorkspaceActivityUpdateListener
} from './WorkspaceActivityBackground'

const completedSnapshot = (workspacePath: string): WorkspaceActivitySnapshot => ({
  workspacePath,
  dayCount: 90,
  generatedAt: Date.now(),
  source: 'git',
  truncated: false,
  events: [{ timestamp: Date.now(), kind: 'git_commit', count: 1, weight: 1.5 }],
  stats: {
    gitRepo: true,
    commits: 1,
    worktreeFiles: 0,
    filesystemFiles: 0,
    scannedFiles: 0,
    scanLimit: 5_000
  }
})

afterEach(() => {
  resetWorkspaceActivityBackgroundForTests()
})

describe('workspace activity background front door', () => {
  it('returns an empty snapshot immediately while a worker scan runs', async () => {
    let finishScan!: (snapshot: WorkspaceActivitySnapshot) => void
    const driver = vi.fn(
      () =>
        new Promise<WorkspaceActivitySnapshot>((resolve) => {
          finishScan = resolve
        })
    )
    const updates: WorkspaceActivitySnapshot[] = []
    setWorkspaceActivityScanDriver(driver)
    setWorkspaceActivityUpdateListener((snapshot) => updates.push(snapshot))

    const initial = getCachedWorkspaceActivitySnapshot('/repo', 90)
    expect(initial.source).toBe('none')
    expect(initial.events).toEqual([])
    expect(driver).toHaveBeenCalledTimes(1)

    // Re-renders join the same worker scan instead of queuing extra scans.
    expect(getCachedWorkspaceActivitySnapshot('/repo', 90).events).toEqual([])
    expect(driver).toHaveBeenCalledTimes(1)

    const finished = completedSnapshot('/repo')
    finishScan(finished)
    await vi.waitFor(() => expect(updates).toEqual([finished]))

    expect(getCachedWorkspaceActivitySnapshot('/repo', 90)).toEqual(finished)
  })

  it('keeps the empty snapshot when no worker driver is installed', () => {
    const snapshot = getCachedWorkspaceActivitySnapshot('/repo', 90)
    expect(snapshot.source).toBe('none')
    expect(snapshot.events).toEqual([])
  })
})
