import { describe, expect, it, vi } from 'vitest'

import { RunManager } from '../RunManager'
import { isTerminalToolResultCompatEvent, ToolBoundarySteerCoordinator } from './ToolBoundarySteer'

function runningManager(): RunManager {
  const runManager = new RunManager()
  runManager.create({
    runId: 'run-1',
    provider: 'claude',
    appChatId: 'chat-1',
    status: 'running'
  })
  runManager.create({
    runId: 'run-2',
    provider: 'codex',
    appChatId: 'chat-2',
    status: 'running'
  })
  return runManager
}

function terminalResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_id: 'tool-1',
    tool_name: 'read_file',
    status: 'success',
    ...overrides
  }
}

describe('isTerminalToolResultCompatEvent', () => {
  it('accepts completed success, error, and status-less tool results', () => {
    expect(isTerminalToolResultCompatEvent(terminalResult())).toBe(true)
    expect(isTerminalToolResultCompatEvent(terminalResult({ status: 'error' }))).toBe(true)
    expect(isTerminalToolResultCompatEvent(terminalResult({ status: undefined }))).toBe(true)
  })

  it('rejects non-result and non-terminal compat events', () => {
    expect(isTerminalToolResultCompatEvent({ type: 'tool_use', status: 'success' })).toBe(false)
    expect(isTerminalToolResultCompatEvent(terminalResult({ status: 'in_progress' }))).toBe(false)
    expect(isTerminalToolResultCompatEvent(terminalResult({ phase: 'running' }))).toBe(false)
    expect(isTerminalToolResultCompatEvent(terminalResult({ partial: true }))).toBe(false)
    expect(isTerminalToolResultCompatEvent(terminalResult({ done: false }))).toBe(false)
    expect(
      isTerminalToolResultCompatEvent(terminalResult({ status: 'adapter-specific-maybe' }))
    ).toBe(false)
  })

  it('rejects cumulative reasoning/thinking pseudo-tool results', () => {
    expect(
      isTerminalToolResultCompatEvent(
        terminalResult({ tool_name: 'ollama_thinking', output: 'still thinking' })
      )
    ).toBe(false)
    expect(
      isTerminalToolResultCompatEvent(
        terminalResult({ tool_name: 'mcp__TaskWraith__claude_reasoning' })
      )
    ).toBe(false)
    expect(
      isTerminalToolResultCompatEvent(
        terminalResult({ tool_name: undefined, parameters: { kind: 'reasoning' } })
      )
    ).toBe(false)
  })
})

describe('ToolBoundarySteerCoordinator', () => {
  it('consults the exact run and interrupts only when that run is armed', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-2', 'queued-2')
    const interruptExactRun = vi.fn(async () => true)
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    await expect(
      coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    ).resolves.toEqual({ kind: 'ignored', reason: 'not-armed', queuedRunIds: [] })
    expect(interruptExactRun).not.toHaveBeenCalled()

    await expect(
      coordinator.observeBoundary({ runId: 'run-2', interruptExactRun })
    ).resolves.toEqual({
      kind: 'interrupted',
      runId: 'run-2',
      queuedRunIds: ['queued-2']
    })
    expect(interruptExactRun).toHaveBeenCalledOnce()
    expect(interruptExactRun).toHaveBeenCalledWith('run-2')
  })

  it('snapshots and consumes every queued steer after accepted interruption', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    runManager.armKillAfterToolResult('run-1', 'queued-2')
    const interruptExactRun = vi.fn(async () => true)
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    await expect(
      coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    ).resolves.toEqual({
      kind: 'interrupted',
      runId: 'run-1',
      queuedRunIds: ['queued-1', 'queued-2']
    })
    expect(runManager.getInterruptState('run-1')).toEqual({
      interruptRequestedAt: undefined,
      killAfterToolResult: undefined,
      pendingBoundarySteerRunIds: undefined
    })
  })

  it('single-flights concurrent observations and consumes rapid additions to the batch', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    let resolveInterrupt: ((accepted: boolean) => void) | undefined
    const interruptExactRun = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveInterrupt = resolve
        })
    )
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    const first = coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    const second = coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })

    expect(second).toBe(first)
    await vi.waitFor(() => expect(interruptExactRun).toHaveBeenCalledOnce())
    runManager.armKillAfterToolResult('run-1', 'queued-2')
    resolveInterrupt?.(true)
    const expected = {
      kind: 'interrupted',
      runId: 'run-1',
      queuedRunIds: ['queued-1', 'queued-2']
    }
    await expect(first).resolves.toEqual(expected)
    await expect(second).resolves.toEqual(expected)
    expect(interruptExactRun).toHaveBeenCalledOnce()
  })

  it('contains callback rejection and leaves the exact batch armed for retry', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    const error = new Error('provider interrupt transport closed')
    const interruptExactRun = vi
      .fn<(runId: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        runManager.armKillAfterToolResult('run-1', 'queued-2')
        throw error
      })
      .mockResolvedValueOnce(true)
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    await expect(
      coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    ).resolves.toEqual({
      kind: 'failed',
      runId: 'run-1',
      queuedRunIds: ['queued-1', 'queued-2'],
      error
    })
    expect(runManager.getInterruptState('run-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-1', 'queued-2']
    })

    await expect(
      coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    ).resolves.toEqual({
      kind: 'interrupted',
      runId: 'run-1',
      queuedRunIds: ['queued-1', 'queued-2']
    })
    expect(interruptExactRun).toHaveBeenCalledTimes(2)
  })

  it('treats explicit provider refusal as failure without consuming the arm', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    const outcome = await coordinator.observeBoundary({
      runId: 'run-1',
      interruptExactRun: async () => false
    })

    expect(outcome.kind).toBe('failed')
    expect(outcome.queuedRunIds).toEqual(['queued-1'])
    expect(runManager.getInterruptState('run-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-1']
    })
  })

  it('consumes a stale arm without interrupting when every queued steer was cancelled', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-cancelled')
    const interruptExactRun = vi.fn(async () => true)
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    await expect(
      coordinator.observeBoundary({
        runId: 'run-1',
        shouldInterrupt: () => false,
        interruptExactRun
      })
    ).resolves.toEqual({
      kind: 'ignored',
      reason: 'no-runnable-steer',
      queuedRunIds: ['queued-cancelled']
    })
    expect(interruptExactRun).not.toHaveBeenCalled()
    expect(runManager.getInterruptState('run-1').killAfterToolResult).toBeUndefined()
  })

  it('invokes the exact interrupt synchronously before the provider can start another request', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    let invoked = false
    const interruptExactRun = vi.fn(() => {
      invoked = true
      return Promise.resolve(true)
    })
    const coordinator = new ToolBoundarySteerCoordinator(runManager)

    const outcomePromise = coordinator.observeBoundary({ runId: 'run-1', interruptExactRun })
    expect(invoked).toBe(true)

    await expect(outcomePromise).resolves.toEqual({
      kind: 'interrupted',
      runId: 'run-1',
      queuedRunIds: ['queued-1']
    })
    expect(interruptExactRun).toHaveBeenCalledWith('run-1')
  })
})
