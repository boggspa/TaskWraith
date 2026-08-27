import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { RunManager } from '../RunManager'
import { createBrokerSteerTransport, formatSteeringInjection } from './BrokerSteerTransport'
import {
  CLAUDE_STEER_BOUNDARY_STOP_REASON,
  createClaudePostToolBatchSteerHook,
  type ClaudePostToolBatchHookInput,
  type ClaudePostToolBatchSteerHook
} from './ClaudePostToolBatchSteer'

function postToolBatch(): ClaudePostToolBatchHookInput {
  return {
    hook_event_name: 'PostToolBatch',
    session_id: 'claude-session-1',
    transcript_path: '/tmp/claude-session-1.jsonl',
    cwd: '/workspace',
    tool_calls: [
      {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/one.ts' },
        tool_use_id: 'tool-1',
        tool_response: 'one'
      },
      {
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/two.ts' },
        tool_use_id: 'tool-2',
        tool_response: 'two'
      }
    ]
  }
}

function runningManager(): RunManager {
  const runManager = new RunManager()
  runManager.create({
    runId: 'run-1',
    provider: 'claude',
    appChatId: 'chat-1',
    status: 'running'
  })
  return runManager
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function makeHook(
  runManager: RunManager,
  onArmedBoundary = vi.fn(async () => true),
  onBoundaryError?: (error: unknown) => void
): ClaudePostToolBatchSteerHook {
  return createClaudePostToolBatchSteerHook({
    runId: 'run-1',
    runManager,
    onArmedBoundary,
    onBoundaryError
  })
}

describe('createClaudePostToolBatchSteerHook', () => {
  it('is structurally assignable to the installed Agent SDK HookCallback', () => {
    const sdkHook: HookCallback = makeHook(runningManager())
    expect(sdkHook).toBeTypeOf('function')
  })

  it('drains broker steering into framed PostToolBatch additionalContext', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    const delivered = vi.fn()
    const transport = createBrokerSteerTransport(
      (text) => {
        session.pendingSteerText = text
      },
      () => session.pendingSteerText ?? null
    )
    runManager.registerLiveSteerTransport('run-1', transport)
    transport.sendSteer('Please inspect the wider layout.', {
      entryId: 'entry-1',
      onDelivered: delivered
    })

    const hook = makeHook(runManager)
    await expect(hook(postToolBatch(), undefined, { signal: signal() })).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: formatSteeringInjection('Please inspect the wider layout.')
      }
    })
    expect(delivered).toHaveBeenCalledOnce()
    expect(session.pendingSteerText).toBeNull()

    await expect(hook(postToolBatch(), undefined, { signal: signal() })).resolves.toEqual({
      continue: true
    })
    expect(delivered).toHaveBeenCalledOnce()
  })

  it('uses one structured callback for the complete parallel batch', async () => {
    const runManager = runningManager()
    runManager.armKillAfterToolResult('run-1', 'queued-1')
    const onArmedBoundary = vi.fn(async () => true)
    const hook = makeHook(runManager, onArmedBoundary)
    const input = postToolBatch()
    const hookSignal = signal()

    await expect(hook(input, undefined, { signal: hookSignal })).resolves.toEqual({
      continue: false,
      stopReason: CLAUDE_STEER_BOUNDARY_STOP_REASON
    })
    expect(onArmedBoundary).toHaveBeenCalledOnce()
    expect(onArmedBoundary).toHaveBeenCalledWith({
      runId: 'run-1',
      input,
      signal: hookSignal
    })
    expect(input.tool_calls).toHaveLength(2)
  })

  it('gives an armed structured boundary precedence without draining text', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    const delivered = vi.fn()
    const transport = createBrokerSteerTransport(
      (text) => {
        session.pendingSteerText = text
      },
      () => session.pendingSteerText ?? null
    )
    runManager.registerLiveSteerTransport('run-1', transport)
    transport.sendSteer('Keep this for the resumed run.', {
      entryId: 'entry-1',
      onDelivered: delivered
    })
    runManager.armKillAfterToolResult('run-1', 'queued-attachment')

    const hook = makeHook(runManager)
    const output = await hook(postToolBatch(), undefined, { signal: signal() })

    expect(output).toEqual({
      continue: false,
      stopReason: CLAUDE_STEER_BOUNDARY_STOP_REASON
    })
    expect(session.pendingSteerText).toBe('Keep this for the resumed run.')
    expect(delivered).not.toHaveBeenCalled()
  })

  it('continues without draining when the exact boundary callback refuses', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    session.pendingSteerText = 'still pending'
    runManager.armKillAfterToolResult('run-1')
    const onArmedBoundary = vi.fn(async () => false)

    await expect(
      makeHook(runManager, onArmedBoundary)(postToolBatch(), undefined, { signal: signal() })
    ).resolves.toEqual({ continue: true })
    expect(session.pendingSteerText).toBe('still pending')
    expect(runManager.getInterruptState('run-1').killAfterToolResult).toBe(true)
  })

  it('contains a boundary callback failure and leaves steering available to retry', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    session.pendingSteerText = 'still pending'
    runManager.armKillAfterToolResult('run-1')
    const error = new Error('Claude interrupt channel closed')
    const onBoundaryError = vi.fn()

    await expect(
      makeHook(
        runManager,
        vi.fn(async () => Promise.reject(error)),
        onBoundaryError
      )(postToolBatch(), undefined, { signal: signal() })
    ).resolves.toEqual({ continue: true })
    expect(onBoundaryError).toHaveBeenCalledWith(error)
    expect(session.pendingSteerText).toBe('still pending')
  })

  it('ignores per-tool and generic renderer events without consuming steering', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    session.pendingSteerText = 'wait for the SDK batch'
    runManager.armKillAfterToolResult('run-1')
    const onArmedBoundary = vi.fn(async () => true)
    const hook = makeHook(runManager, onArmedBoundary)

    await expect(
      hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'tool-1' }, 'tool-1', {
        signal: signal()
      })
    ).resolves.toEqual({ continue: true })
    await expect(
      hook({ type: 'tool_result', status: 'success' }, undefined, { signal: signal() })
    ).resolves.toEqual({ continue: true })

    expect(session.pendingSteerText).toBe('wait for the SDK batch')
    expect(onArmedBoundary).not.toHaveBeenCalled()
  })

  it('does not claim delivery from a native Claude subagent batch', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    session.pendingSteerText = 'steer the primary seat'
    runManager.armKillAfterToolResult('run-1')
    const onArmedBoundary = vi.fn(async () => true)
    const hook = makeHook(runManager, onArmedBoundary)
    const input = { ...postToolBatch(), agent_id: 'native-agent-1' }

    await expect(hook(input, undefined, { signal: signal() })).resolves.toEqual({
      continue: true
    })
    expect(session.pendingSteerText).toBe('steer the primary seat')
    expect(onArmedBoundary).not.toHaveBeenCalled()
  })

  it('does not drain or interrupt after the hook signal is aborted', async () => {
    const runManager = runningManager()
    const session = runManager.get('run-1')!
    session.pendingSteerText = 'preserve me'
    runManager.armKillAfterToolResult('run-1')
    const onArmedBoundary = vi.fn(async () => true)
    const hook = makeHook(runManager, onArmedBoundary)
    const controller = new AbortController()
    controller.abort()

    await expect(hook(postToolBatch(), undefined, { signal: controller.signal })).resolves.toEqual({
      continue: true
    })
    expect(onArmedBoundary).not.toHaveBeenCalled()
    expect(session.pendingSteerText).toBe('preserve me')
  })

  it('rejects construction without an exact run identity', () => {
    const runManager = runningManager()
    expect(() =>
      createClaudePostToolBatchSteerHook({
        runId: '   ',
        runManager,
        onArmedBoundary: async () => true
      })
    ).toThrow(/exact run id/i)
  })
})
