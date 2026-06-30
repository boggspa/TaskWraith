import { describe, it, expect, vi } from 'vitest'
import {
  createLaunchToolExecutors,
  isLaunchMcpToolName,
  LAUNCH_MCP_TOOL_NAMES,
  type LaunchController
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
