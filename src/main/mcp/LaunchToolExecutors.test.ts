import { describe, it, expect, vi } from 'vitest'
import {
  createLaunchToolExecutors,
  isLaunchMcpToolName,
  LAUNCH_MCP_TOOL_NAMES,
  type LaunchController,
  type LaunchStartOutcome
} from './LaunchToolExecutors'
import type { LaunchTarget } from '../launchTargets/types'
import type { LaunchAttempt } from '../launch/types'

function fakeTarget(over: Partial<LaunchTarget> = {}): LaunchTarget {
  return {
    id: 'npm-dev',
    label: 'npm run dev',
    workspacePath: '/ws',
    source: 'package-json',
    kind: 'dev-server',
    platform: 'web',
    confidence: 1,
    command: { raw: 'npm run dev', argv: ['npm', 'run', 'dev'], cwd: '/ws', longRunning: true },
    evidence: [],
    blockers: [],
    ...over
  } as LaunchTarget
}

function fakeAttempt(over: Partial<LaunchAttempt> = {}): LaunchAttempt {
  return {
    id: 'att1',
    targetId: 'npm-dev',
    targetLabel: 'npm run dev',
    status: 'running',
    detectedUrls: ['http://localhost:3000'],
    startedAt: 'T',
    chatId: 'c1',
    ...over
  } as LaunchAttempt
}

function fakeController(over: Partial<LaunchController> = {}): LaunchController {
  return {
    listTargets: async () => [fakeTarget()],
    start: async () => ({ ok: true, attempt: fakeAttempt() }),
    stop: async () => ({ ok: true, attempt: fakeAttempt({ status: 'stopped' }) }),
    attempts: () => [fakeAttempt()],
    ...over
  }
}

const ctx = { appChatId: 'c1', appRunId: 'r1', workspacePath: '/ws' }

describe('isLaunchMcpToolName', () => {
  it('matches the launch tools and nothing else', () => {
    for (const n of LAUNCH_MCP_TOOL_NAMES) expect(isLaunchMcpToolName(n)).toBe(true)
    expect(isLaunchMcpToolName('run_shell_command')).toBe(false)
  })
})

describe('executeLaunchTool', () => {
  it('launch_list_targets returns trimmed discovered targets for the run workspace', async () => {
    const listTargets = vi.fn(async () => [fakeTarget()])
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController({ listTargets }) })
    const r = await executeLaunchTool('launch_list_targets', {}, ctx, 'claude')
    expect(r.isError).toBeFalsy()
    expect(listTargets).toHaveBeenCalledWith('/ws')
    const targets = r.structuredContent?.targets as Array<Record<string, unknown>>
    expect(targets[0]).toMatchObject({ targetId: 'npm-dev', command: 'npm run dev', runnable: true })
  })

  it('launch_start resolves the target by id and starts it, threading the approval sender', async () => {
    let started: unknown = null
    const controller = fakeController({
      start: async (input) => {
        started = input
        return { ok: true, attempt: fakeAttempt() }
      }
    })
    const sender = { isDestroyed: () => false }
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool(
      'launch_start',
      { targetId: 'npm-dev' },
      { ...ctx, sender },
      'claude'
    )
    expect(r.isError).toBeFalsy()
    expect(started).toMatchObject({ provider: 'claude', chatId: 'c1', runId: 'r1' })
    expect((started as { target: LaunchTarget }).target.id).toBe('npm-dev')
    // The run's approval surface must reach startTarget (a null sender auto-denies).
    expect((started as { sender: unknown }).sender).toBe(sender)
    expect(r.structuredContent?.attemptId).toBe('att1')
  })

  it('launch_start rejects an unknown targetId WITHOUT starting anything', async () => {
    const start = vi.fn(async () => ({ ok: true, attempt: fakeAttempt() }))
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController({ start }) })
    const r = await executeLaunchTool('launch_start', { targetId: 'does-not-exist' }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })

  it('launch_start surfaces a denied/failed start as an error', async () => {
    const controller = fakeController({
      start: async () => ({ ok: false, error: 'Launch denied by TaskWraith approval policy.' })
    })
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool('launch_start', { targetId: 'npm-dev' }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(String(r.structuredContent?.error)).toMatch(/denied/)
  })

  it('launch_start refuses an already-active attempt owned by another chat', async () => {
    const controller = fakeController({
      start: async () => ({
        ok: true,
        attempt: fakeAttempt({ id: 'foreign', chatId: 'c2', detectedUrls: ['http://localhost:9999'] })
      })
    })
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool('launch_start', { targetId: 'npm-dev' }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(String(r.structuredContent?.error)).toBe('Launch target is unavailable.')
    expect(JSON.stringify(r.structuredContent)).not.toContain('9999')
    expect(JSON.stringify(r.structuredContent)).not.toContain('foreign')
  })

  it('launch_start requires a chat-scoped run before it can spawn', async () => {
    const start = vi.fn(async () => ({ ok: true, attempt: fakeAttempt({ chatId: undefined }) }))
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController({ start }) })
    const r = await executeLaunchTool(
      'launch_start',
      { targetId: 'npm-dev' },
      { appRunId: 'r1', workspacePath: '/ws' },
      'claude'
    )
    expect(r.isError).toBe(true)
    expect(String(r.structuredContent?.error)).toMatch(/chat-scoped/)
    expect(start).not.toHaveBeenCalled()
  })

  it('launch_stop and launch_status work', async () => {
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController() })
    const stop = await executeLaunchTool('launch_stop', { attemptId: 'att1' }, ctx, 'claude')
    expect(stop.isError).toBeFalsy()
    expect(stop.structuredContent?.status).toBe('stopped')
    const status = await executeLaunchTool('launch_status', {}, ctx, 'claude')
    expect(status.isError).toBeFalsy()
    expect((status.structuredContent?.attempts as unknown[]).length).toBe(1)
  })

  it('launch_stop requires an attemptId', async () => {
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController() })
    const r = await executeLaunchTool('launch_stop', {}, ctx, 'claude')
    expect(r.isError).toBe(true)
  })

  it('launch_status only surfaces the calling chat\'s attempts (no cross-chat leak)', async () => {
    const controller = fakeController({
      attempts: () => [
        fakeAttempt({ id: 'mine', chatId: 'c1' }),
        fakeAttempt({ id: 'other', chatId: 'c2', targetLabel: 'secret', detectedUrls: ['http://localhost:9999'] })
      ]
    })
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool('launch_status', {}, ctx, 'claude')
    const attempts = r.structuredContent?.attempts as Array<Record<string, unknown>>
    expect(attempts).toHaveLength(1)
    expect(attempts[0].attemptId).toBe('mine')
  })

  it('launch_status does not expose unattributed attempts to no-chat runs', async () => {
    const controller = fakeController({
      attempts: () => [fakeAttempt({ id: 'legacy', chatId: undefined })]
    })
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool('launch_status', {}, { appRunId: 'r1', workspacePath: '/ws' }, 'claude')
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent?.attempts).toEqual([])
  })

  it('launch_stop refuses another chat\'s attemptId without signaling the process', async () => {
    const stop = vi.fn(async () => ({ ok: true, attempt: fakeAttempt() }))
    const controller = fakeController({
      attempts: () => [fakeAttempt({ id: 'other', chatId: 'c2' })],
      stop
    })
    const { executeLaunchTool } = createLaunchToolExecutors({ controller })
    const r = await executeLaunchTool('launch_stop', { attemptId: 'other' }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(String(r.structuredContent?.error)).toMatch(/not found/)
    expect(stop).not.toHaveBeenCalled()
  })
})

describe('launch_adopt', () => {
  const ctx = { appChatId: 'chat-a', appRunId: 'run-a', workspacePath: '/workspace' }

  function adoptedAttempt(overrides: Partial<LaunchAttempt> = {}): LaunchAttempt {
    return {
      ...fakeAttempt(),
      id: 'adopted-1',
      pid: 8123,
      adopted: true,
      chatId: 'chat-a',
      runId: 'run-a',
      ...overrides
    }
  }

  it('adopts a process the run started and points at the next step', async () => {
    const adopt = vi.fn(async () => ({ ok: true, attempt: adoptedAttempt() }))
    const { executeLaunchTool } = createLaunchToolExecutors({
      controller: { ...fakeController(), adopt }
    })

    const result = await executeLaunchTool('launch_adopt', { pid: 8123 }, ctx, 'claude')

    expect(result.isError).toBeFalsy()
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 8123, chatId: 'chat-a', runId: 'run-a' })
    )
    expect(String(result.structuredContent?.next)).toMatch(/Screen Watch/)
  })

  it('requires a real pid and a chat-scoped run', async () => {
    const adopt = vi.fn(async () => ({ ok: true, attempt: adoptedAttempt() }))
    const { executeLaunchTool } = createLaunchToolExecutors({
      controller: { ...fakeController(), adopt }
    })

    for (const args of [{}, { pid: 0 }, { pid: 1 }, { pid: -5 }, { pid: 'nope' }]) {
      expect((await executeLaunchTool('launch_adopt', args, ctx, 'claude')).isError).toBe(true)
    }
    expect(
      (await executeLaunchTool('launch_adopt', { pid: 8123 }, { workspacePath: '/w' }, 'claude'))
        .isError
    ).toBe(true)
    expect(adopt).not.toHaveBeenCalled()
  })

  it('reports adoption as unavailable rather than silently doing nothing', async () => {
    const { executeLaunchTool } = createLaunchToolExecutors({ controller: fakeController() })

    const result = await executeLaunchTool('launch_adopt', { pid: 8123 }, ctx, 'claude')

    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(/unavailable/i)
  })

  it('never returns another chat’s attempt', async () => {
    const adopt = vi.fn(async () => ({ ok: true, attempt: adoptedAttempt({ chatId: 'chat-b' }) }))
    const { executeLaunchTool } = createLaunchToolExecutors({
      controller: { ...fakeController(), adopt }
    })

    expect((await executeLaunchTool('launch_adopt', { pid: 8123 }, ctx, 'claude')).isError).toBe(
      true
    )
  })
})

describe('launch_adopt Ensemble authority', () => {
  const ctx = { appChatId: 'chat-a', appRunId: 'run-a', workspacePath: '/workspace' }

  function harness() {
    const adopt = vi.fn(
      async (_input: unknown): Promise<LaunchStartOutcome> => ({
        ok: true,
        attempt: {
          ...fakeAttempt(),
          id: 'adopted-1',
          pid: 8123,
          adopted: true,
          chatId: 'chat-a'
        }
      })
    )
    return {
      adopt,
      executors: createLaunchToolExecutors({ controller: { ...fakeController(), adopt } })
    }
  }

  it('refuses an Ensemble participant without Boss/Captain authority', async () => {
    const { adopt, executors } = harness()

    const result = await executors.executeLaunchTool(
      'launch_adopt',
      { pid: 8123 },
      { ...ctx, assertAppDriveAuthority: () => ({ ok: false, reason: 'Boss or a Captain only.' }) },
      'claude'
    )

    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(/Boss or a Captain/)
    // Refused before the controller is reached, so nothing is recorded.
    expect(adopt).not.toHaveBeenCalled()
  })

  it('allows a Boss/Captain participant', async () => {
    const { adopt, executors } = harness()

    const result = await executors.executeLaunchTool(
      'launch_adopt',
      { pid: 8123 },
      { ...ctx, assertAppDriveAuthority: () => ({ ok: true }) },
      'claude'
    )

    expect(result.isError).toBeFalsy()
    expect(adopt).toHaveBeenCalled()
  })
})
