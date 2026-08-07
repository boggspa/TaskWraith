import { describe, expect, it } from 'vitest'
import {
  resolveAppshotsTargetOwnership,
  type AppshotsLaunchCandidate,
  type AppshotsSpawnCandidate
} from './AppshotsTargetOwnership'

const chatId = 'chat-1'
const workspacePath = '/Users/chris/proj'

function spawn(partial: Partial<AppshotsSpawnCandidate> & { pid: number }): AppshotsSpawnCandidate {
  return {
    chatId,
    startedAt: '2026-08-07T20:00:00.000Z',
    ...partial
  }
}

function launch(
  partial: Partial<AppshotsLaunchCandidate> & { pid: number }
): AppshotsLaunchCandidate {
  return {
    chatId,
    status: 'running',
    workspacePath,
    cwd: workspacePath,
    processStartedAt: '2026-08-07T20:00:00.000Z',
    ...partial
  }
}

describe('resolveAppshotsTargetOwnership', () => {
  it('allows the currently attached window when pid is omitted', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      attached: { pid: 4242, processStartedAt: '2026-08-07T19:00:00.000Z', chatId },
      spawns: [],
      launches: []
    })
    expect(result).toEqual({
      allowed: true,
      reason: 'attached',
      target: {
        pid: 4242,
        kind: 'attached',
        chatId,
        processStartedAt: '2026-08-07T19:00:00.000Z'
      }
    })
  })

  it('allows when requested pid matches the attached window', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 4242,
      attached: { pid: 4242, chatId },
      spawns: [],
      launches: []
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('attached')
  })

  it('rejects when requested pid mismatches the attached window and is not otherwise owned', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 99,
      attached: { pid: 4242, chatId },
      spawns: [],
      launches: []
    })
    expect(result).toEqual({ allowed: false, reason: 'foreign' })
  })

  it('allows a TaskWraith-tracked spawn for this chat', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 77,
      attached: null,
      spawns: [spawn({ pid: 77, provider: 'codex' })],
      launches: []
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('spawned')
    expect(result.target?.pid).toBe(77)
  })

  it('allows a live launch attempt for this chat', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 88,
      attached: null,
      spawns: [],
      launches: [launch({ pid: 88 })]
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('launch')
  })

  it('treats a workspace-artifact launch (cwd inside workspace) as owned even without chatId match when spawn is workspace-scoped', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      workspacePath,
      requestedPid: 55,
      attached: null,
      spawns: [],
      launches: [
        launch({
          pid: 55,
          chatId: 'other-chat',
          cwd: `${workspacePath}/apps/web`,
          status: 'running'
        })
      ]
    })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('workspace-artifact')
  })

  it('refuses foreign pids', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 12345,
      attached: null,
      spawns: [spawn({ pid: 1, chatId: 'other' })],
      launches: [launch({ pid: 2, chatId: 'other', cwd: '/tmp' })],
      workspacePath
    })
    expect(result).toEqual({ allowed: false, reason: 'foreign' })
  })

  it('reports missing when no pid and no attachment', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      attached: null,
      spawns: [],
      launches: []
    })
    expect(result).toEqual({ allowed: false, reason: 'missing' })
  })

  it('ignores non-live launch statuses', () => {
    const result = resolveAppshotsTargetOwnership({
      chatId,
      requestedPid: 88,
      attached: null,
      spawns: [],
      launches: [launch({ pid: 88, status: 'stopped' })]
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('foreign')
  })
})
