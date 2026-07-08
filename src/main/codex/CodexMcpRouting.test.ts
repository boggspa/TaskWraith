import { describe, expect, it } from 'vitest'

import {
  codexMcpRoutingKey,
  resolveCodexMcpRouteHint,
  type CodexMcpRouteHint
} from './CodexMcpRouting'

describe('CodexMcpRouting', () => {
  it('normalizes object key order when building routing keys', () => {
    expect(codexMcpRoutingKey('delegate_to_subthread', { b: 2, a: 1 })).toBe(
      codexMcpRoutingKey('delegate_to_subthread', { a: 1, b: 2 })
    )
  })

  it('normalizes TaskWraith tool aliases when building routing keys', () => {
    expect(codexMcpRoutingKey('ASkUserQuestion', { question: 'Continue?' })).toBe(
      codexMcpRoutingKey('ask_user_question', { question: 'Continue?' })
    )
  })

  it('resolves a unique fresh hint', () => {
    const route = { appRunId: 'run-1', appChatId: 'chat-1' }
    const hints: CodexMcpRouteHint[] = [
      {
        itemId: 'item-1',
        toolName: 'delegate_to_subthread',
        args: { provider: 'claude', prompt: 'hi' },
        route,
        startedAtMs: 1_000
      }
    ]

    expect(
      resolveCodexMcpRouteHint({
        hints,
        nowMs: 1_500,
        toolName: 'delegate_to_subthread',
        args: { prompt: 'hi', provider: 'claude' },
        maxAgeMs: 5_000
      })
    ).toEqual(route)
  })

  it('resolves a fresh hint when the provider used an AskUserQuestion alias', () => {
    const route = { appRunId: 'run-1', appChatId: 'chat-1' }
    const hints: CodexMcpRouteHint[] = [
      {
        itemId: 'item-1',
        toolName: 'ASkUserQuestion',
        args: { question: 'Continue?' },
        route,
        startedAtMs: 1_000
      }
    ]

    expect(
      resolveCodexMcpRouteHint({
        hints,
        nowMs: 1_500,
        toolName: 'ask_user_question',
        args: { question: 'Continue?' },
        maxAgeMs: 5_000
      })
    ).toEqual(route)
  })

  it('fails closed when the match is ambiguous', () => {
    const hints: CodexMcpRouteHint[] = [
      {
        itemId: 'item-1',
        toolName: 'delegate_to_subthread',
        args: { provider: 'claude' },
        route: { appRunId: 'run-1', appChatId: 'chat-1' },
        startedAtMs: 1_000
      },
      {
        itemId: 'item-2',
        toolName: 'delegate_to_subthread',
        args: { provider: 'claude' },
        route: { appRunId: 'run-2', appChatId: 'chat-2' },
        startedAtMs: 1_100
      }
    ]

    expect(
      resolveCodexMcpRouteHint({
        hints,
        nowMs: 1_500,
        toolName: 'delegate_to_subthread',
        args: { provider: 'claude' },
        maxAgeMs: 5_000
      })
    ).toBeNull()
  })
})
