import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  ChannelAgentRunIsolationRegistry,
  ChannelAgentRunIsolationRegistryError,
  redactChannelAgentUsageContent
} from './ChannelAgentRunIsolationRegistry'

function payload(runId: string, chatId = 'chat-one'): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/workspace',
    prompt: 'Channel turn',
    appRunId: runId,
    appChatId: chatId,
    approvalMode: 'plan'
  }
}

function expectCode(
  action: () => unknown,
  code: ChannelAgentRunIsolationRegistryError['code']
): void {
  try {
    action()
    throw new Error(`Expected ChannelAgentRunIsolationRegistryError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelAgentRunIsolationRegistryError)
    expect((error as ChannelAgentRunIsolationRegistryError).code).toBe(code)
  }
}

describe('ChannelAgentRunIsolationRegistry', () => {
  it('removes persisted prompt and response bodies without mutating numeric usage', () => {
    const usage = {
      provider: 'codex' as const,
      workspaceId: 'workspace-one',
      chatId: 'chat-one',
      runId: 'channel-run-usage',
      usageKind: 'run' as const,
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      durationMs: 40,
      promptText: 'private Channel prompt',
      responseText: 'private Channel response'
    }

    expect(redactChannelAgentUsageContent(usage)).toEqual({
      provider: 'codex',
      workspaceId: 'workspace-one',
      chatId: 'chat-one',
      runId: 'channel-run-usage',
      usageKind: 'run',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      durationMs: 40
    })
    expect(usage.promptText).toBe('private Channel prompt')
    expect(usage.responseText).toBe('private Channel response')
  })

  it('isolates one exact main-registered run through its settled tail', () => {
    const registry = new ChannelAgentRunIsolationRegistry()
    const lease = registry.register(payload('channel-run-one'))

    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(lease.binding)).toBe(true)
    expect(registry.isRunIsolated('channel-run-one')).toBe(true)
    expect(lease.settle()).toBe(true)
    expect(lease.settle()).toBe(false)
    expect(registry.isRunIsolated('channel-run-one')).toBe(true)
  })

  it('keeps isolation fail-closed when mutable route fields are rebound', () => {
    const registry = new ChannelAgentRunIsolationRegistry()
    registry.register(payload('channel-run-rebound'))

    expect(
      registry.isPayloadIsolated({
        ...payload('channel-run-rebound', 'attacker-chat'),
        provider: 'claude',
        workspace: '/other-workspace'
      })
    ).toBe(true)
    expect(registry.isPayloadIsolated(payload('ordinary-run'))).toBe(false)
  })

  it('rejects duplicate, rebound, and malformed registrations', () => {
    const registry = new ChannelAgentRunIsolationRegistry()
    registry.register(payload('channel-run-duplicate'))

    expectCode(() => registry.register(payload('channel-run-duplicate')), 'duplicate_run')
    expectCode(
      () => registry.register(payload('channel-run-duplicate', 'other-chat')),
      'binding_conflict'
    )
    expectCode(() => registry.register(payload(' channel-run-invalid')), 'invalid_input')
    expectCode(
      () => registry.register({ ...payload('channel-run-no-chat'), appChatId: undefined }),
      'invalid_input'
    )
  })

  it('fails at active capacity without evicting a live isolation', () => {
    const registry = new ChannelAgentRunIsolationRegistry({
      maxActiveRuns: 2,
      maxSettledRuns: 2
    })
    registry.register(payload('channel-run-first'))
    registry.register(payload('channel-run-second'))

    expectCode(() => registry.register(payload('channel-run-third')), 'capacity_exceeded')
    expect(registry.isRunIsolated('channel-run-first')).toBe(true)
    expect(registry.isRunIsolated('channel-run-second')).toBe(true)
  })

  it('bounds settled tombstones and stale leases cannot settle a reused id', () => {
    const registry = new ChannelAgentRunIsolationRegistry({
      maxActiveRuns: 2,
      maxSettledRuns: 1
    })
    const old = registry.register(payload('channel-run-reused'))
    expect(old.settle()).toBe(true)
    const other = registry.register(payload('channel-run-other'))
    expect(other.settle()).toBe(true)
    expect(registry.isRunIsolated('channel-run-reused')).toBe(false)

    const current = registry.register(payload('channel-run-reused'))
    expect(old.settle()).toBe(false)
    expect(registry.isRunIsolated('channel-run-reused')).toBe(true)
    expect(current.settle()).toBe(true)
  })
})
