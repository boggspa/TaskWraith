import { describe, expect, it } from 'vitest'

import { CHANNEL_AGENT_MAX_POST_BYTES } from '../../shared/collaboration/ChannelAgentProtocol'
import type { RunEvent } from '../RunEventBus'
import type { RunSessionChangeEvent, RunSessionStatus } from '../RunManager'
import type { ProviderId } from '../store/types'
import {
  ChannelAgentRunEventCollector,
  ChannelAgentRunEventCollectorError,
  type ChannelAgentRunCollectionBinding
} from './ChannelAgentRunEventCollector'

const RUN_ID = 'channel-agent-run-collector-proof'
const CHAT_ID = 'channel-agent-chat-collector-proof'
const WORKSPACE_PATH = '/workspace/channel-agent-collector'
const PROVIDER: ProviderId = 'codex'

function binding(
  overrides: Partial<ChannelAgentRunCollectionBinding> = {}
): ChannelAgentRunCollectionBinding {
  return {
    runId: RUN_ID,
    chatId: CHAT_ID,
    provider: PROVIDER,
    workspacePath: WORKSPACE_PATH,
    launchIntentAt: 100,
    maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES,
    ...overrides
  }
}

function compatEvent(
  payload: Record<string, unknown>,
  overrides: {
    runId?: string
    chatId?: string
    provider?: ProviderId
    channel?: RunEvent['channel']
  } = {}
): RunEvent {
  const runId = overrides.runId ?? RUN_ID
  const chatId = overrides.chatId ?? CHAT_ID
  const provider = overrides.provider ?? PROVIDER
  const inner = {
    ...payload,
    provider,
    appRunId: runId,
    appChatId: chatId
  }
  return {
    channel: overrides.channel ?? 'agent-output',
    provider,
    payload: {
      provider,
      data: `${JSON.stringify(inner)}\n`,
      appRunId: runId,
      appChatId: chatId,
      compatLine: true
    },
    publishedAt: '2026-08-10T00:00:00.000Z'
  }
}

function exitEvent(
  code: number | null,
  overrides: { runId?: string; chatId?: string; provider?: ProviderId } = {}
): RunEvent {
  const runId = overrides.runId ?? RUN_ID
  const chatId = overrides.chatId ?? CHAT_ID
  const provider = overrides.provider ?? PROVIDER
  return {
    channel: 'agent-exit',
    provider,
    payload: { provider, appRunId: runId, appChatId: chatId, code },
    publishedAt: '2026-08-10T00:00:01.000Z'
  }
}

function sessionEvent(
  status: RunSessionStatus,
  overrides: {
    type?: RunSessionChangeEvent['type']
    runId?: string
    chatId?: string
    provider?: ProviderId
    workspacePath?: string
  } = {}
): RunSessionChangeEvent {
  return {
    type: overrides.type ?? 'updated',
    session: {
      runId: overrides.runId ?? RUN_ID,
      provider: overrides.provider ?? PROVIDER,
      appChatId: overrides.chatId ?? CHAT_ID,
      workspacePath: overrides.workspacePath ?? WORKSPACE_PATH,
      status,
      startedAt: 100,
      updatedAt: 101,
      approvalIds: new Set(),
      sessionGrants: new Set()
    }
  }
}

function receipt(overrides: { provider?: ProviderId; workspacePath?: string } = {}) {
  return {
    provider: overrides.provider ?? PROVIDER,
    appRunId: RUN_ID,
    effectiveWorkspacePath: overrides.workspacePath ?? WORKSPACE_PATH
  }
}

function clock(start = 100): () => number {
  let value = start
  return () => (value += 1)
}

async function expectCollectorError(operation: () => unknown, code: string): Promise<void> {
  try {
    await operation()
    throw new Error('Expected ChannelAgentRunEventCollectorError')
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelAgentRunEventCollectorError)
    expect(error).toMatchObject({ code })
  }
}

describe('ChannelAgentRunEventCollector', () => {
  it('buffers synchronous output until exact launch and lifecycle evidence agree', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    let settled = false
    void tracked.terminal.then(() => {
      settled = true
    })

    collector.handle(compatEvent({ type: 'content', text: 'test ' }))
    collector.handle(compatEvent({ type: 'content', text: 'test ' }))
    collector.handle(
      compatEvent({ type: 'content', text: 'test test complete', runItemCumulative: true })
    )
    collector.handle(compatEvent({ type: 'result', status: 'completed' }))
    collector.handleRunSessionChange(sessionEvent('completed'))
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(collector.pendingCount()).toBe(1)

    collector.confirmAdapterInvocation(receipt(), 110)

    await expect(tracked.terminal).resolves.toEqual({
      status: 'succeeded',
      exitCode: null,
      content: 'test test complete',
      observedAt: 110
    })
    expect(collector.pendingCount()).toBe(0)
  })

  it('accepts an exact exit as provider terminal evidence', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handle(compatEvent({ type: 'content', text: 'Final answer.' }))
    collector.handle(exitEvent(0))
    collector.handleRunSessionChange(sessionEvent('completed'))

    await expect(tracked.terminal).resolves.toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      content: 'Final answer.'
    })
  })

  it('does not mistake an interim result for terminal evidence', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    let settled = false
    void tracked.terminal.then(() => {
      settled = true
    })
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handle(compatEvent({ type: 'content', text: 'Still working.' }))
    collector.handle(compatEvent({ type: 'result', status: 'running' }))
    collector.handleRunSessionChange(sessionEvent('completed'))
    await Promise.resolve()
    expect(settled).toBe(false)

    collector.handle(exitEvent(0))
    await expect(tracked.terminal).resolves.toMatchObject({
      status: 'succeeded',
      content: 'Still working.'
    })
  })

  it('rejects provider text that arrives after terminal result evidence', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.handle(compatEvent({ type: 'content', text: 'Initial answer.' }))
    collector.handle(compatEvent({ type: 'result', status: 'success', error: '' }))
    collector.handle(compatEvent({ type: 'content', text: ' late mutation' }))
    collector.handleRunSessionChange(sessionEvent('completed'))
    collector.confirmAdapterInvocation(receipt(), 110)

    const terminal = await tracked.terminal
    expect(terminal.status).toBe('failed')
    expect(terminal.content).toContain('routing checks')
    expect(terminal.content).not.toContain('Initial answer')
  })

  it('ignores other runs and non-canonical mirror channels', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handle(compatEvent({ type: 'content', text: 'other' }, { runId: 'other-run' }))
    collector.handle(
      compatEvent({ type: 'content', text: 'duplicate mirror' }, { channel: 'gemini-output' })
    )
    collector.handle(compatEvent({ type: 'content', text: 'Exact reply.' }))
    collector.handle(compatEvent({ type: 'result', status: 'success' }))
    collector.handleRunSessionChange(sessionEvent('completed'))

    await expect(tracked.terminal).resolves.toMatchObject({ content: 'Exact reply.' })
  })

  it('fails closed on routed provider, chat, or lifecycle workspace drift', async () => {
    const cases: Array<(collector: ChannelAgentRunEventCollector) => void> = [
      (collector) =>
        collector.handle(
          compatEvent(
            { type: 'content', text: 'secret wrong-provider bytes' },
            { provider: 'claude' }
          )
        ),
      (collector) =>
        collector.handle(
          compatEvent(
            { type: 'content', text: 'secret wrong-chat bytes' },
            { chatId: 'other-chat' }
          )
        ),
      (collector) =>
        collector.handleRunSessionChange(
          sessionEvent('running', { workspacePath: '/workspace/other' })
        )
    ]

    for (const injectDrift of cases) {
      const collector = new ChannelAgentRunEventCollector({ now: clock() })
      const tracked = collector.track(binding())
      collector.confirmAdapterInvocation(receipt(), 101)
      injectDrift(collector)
      collector.handle(compatEvent({ type: 'result', status: 'completed' }))
      collector.handleRunSessionChange(sessionEvent('completed'))
      const terminal = await tracked.terminal
      expect(terminal).toMatchObject({ status: 'failed' })
      expect(terminal.content).toContain('routing checks')
      expect(terminal.content).not.toContain('secret')
    }
  })

  it('publishes no partial reply after the signed byte ceiling is exceeded', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handle(
      compatEvent({ type: 'content', text: 'x'.repeat(CHANNEL_AGENT_MAX_POST_BYTES + 1) })
    )
    collector.handle(exitEvent(0))
    collector.handleRunSessionChange(sessionEvent('completed'))

    const terminal = await tracked.terminal
    expect(terminal.status).toBe('failed')
    expect(terminal.content).toContain('exceeded the signed post limit')
    expect(terminal.content).not.toContain('xxx')
  })

  it.each([
    ['failed', 1, 'failed'],
    ['cancelled', 130, 'cancelled']
  ] as const)(
    'projects %s lifecycle as bounded terminal copy without provider errors',
    async (lifecycleStatus, exitCode, expectedStatus) => {
      const collector = new ChannelAgentRunEventCollector({ now: clock() })
      const tracked = collector.track(binding())
      collector.confirmAdapterInvocation(receipt(), 101)
      collector.handle(compatEvent({ type: 'content', text: 'partial secret response' }))
      collector.handle(exitEvent(exitCode))
      collector.handleRunSessionChange(sessionEvent(lifecycleStatus))

      const terminal = await tracked.terminal
      expect(terminal.status).toBe(expectedStatus)
      expect(terminal.content).not.toContain('partial secret response')
    }
  )

  it('fails closed when provider and lifecycle terminal status conflict', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handle(compatEvent({ type: 'content', text: 'uncommitted answer' }))
    collector.handle(compatEvent({ type: 'result', status: 'completed' }))
    collector.handleRunSessionChange(sessionEvent('failed'))

    const terminal = await tracked.terminal
    expect(terminal.status).toBe('failed')
    expect(terminal.content).toContain('conflicting terminal signals')
    expect(terminal.content).not.toContain('uncommitted answer')
  })

  it('treats non-terminal RunManager removal as a bounded failure', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    const tracked = collector.track(binding())
    collector.confirmAdapterInvocation(receipt(), 101)
    collector.handleRunSessionChange(sessionEvent('running', { type: 'removed' }))

    await expect(tracked.terminal).resolves.toMatchObject({
      status: 'failed',
      content: expect.stringContaining('routing checks')
    })
  })

  it('rejects malformed, duplicate, and mismatched launch bindings', async () => {
    const collector = new ChannelAgentRunEventCollector({ now: clock() })
    await expectCollectorError(
      () => collector.track(binding({ maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES - 1 })),
      'invalid_binding'
    )
    const tracked = collector.track(binding())
    await expectCollectorError(() => collector.track(binding()), 'duplicate_run')
    await expectCollectorError(
      () =>
        collector.confirmAdapterInvocation(receipt({ workspacePath: '/workspace/rebound' }), 101),
      'launch_mismatch'
    )
    expect(tracked.stop()).toBe(true)
    expect(tracked.stop()).toBe(false)
    expect(collector.pendingCount()).toBe(0)
  })
})
