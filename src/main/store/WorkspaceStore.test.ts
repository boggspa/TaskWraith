import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-workspace-store-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const workspacesPath = join(userDataPath, 'workspaces.json')

describe('AppStore workspace real-path pinning', () => {
  beforeEach(() => {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(workspacesPath, '[]')
  })

  it('compare-and-sets a missing pin without touching lastOpenedAt or array order', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const first = AppStore.addOrUpdateWorkspace('/repo/first')
      const second = AppStore.addOrUpdateWorkspace('/repo/second')
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))

      const pinned = AppStore.pinWorkspaceRealPath(first.id, first.path, '/real/repo/first')

      expect(pinned).toMatchObject({
        id: first.id,
        path: first.path,
        realPath: '/real/repo/first',
        lastOpenedAt: first.lastOpenedAt
      })
      expect(AppStore.getWorkspaces().map((workspace) => workspace.id)).toEqual([
        first.id,
        second.id
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects stale id and lexical-path comparisons without writing', () => {
    const workspace = AppStore.addOrUpdateWorkspace('/repo/first')
    const before = fs.readFileSync(workspacesPath, 'utf8')

    expect(AppStore.pinWorkspaceRealPath('other-id', workspace.path, '/real/repo/first')).toBeNull()
    expect(
      AppStore.pinWorkspaceRealPath(workspace.id, '/repo/other', '/real/repo/first')
    ).toBeNull()
    expect(fs.readFileSync(workspacesPath, 'utf8')).toBe(before)
  })

  it('never rotates an existing pin through the compare-and-set path', () => {
    const workspace = AppStore.addOrUpdateWorkspace('/repo/first', {
      realPath: '/real/repo/original'
    })
    const before = fs.readFileSync(workspacesPath, 'utf8')

    expect(
      AppStore.pinWorkspaceRealPath(workspace.id, workspace.path, '/real/repo/replacement')
    ).toBeNull()
    expect(
      AppStore.pinWorkspaceRealPath(workspace.id, workspace.path, workspace.realPath!)
    ).toBeNull()
    expect(fs.readFileSync(workspacesPath, 'utf8')).toBe(before)
  })
})
