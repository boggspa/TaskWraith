import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveDelegationStatus,
  isSubThreadDelegationMessage
} from './SubThreadDelegationCardModel'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { findClickableByClassName } from '../test/reactElementTree'
import { SubThreadDelegationCard } from './SubThreadDelegationCard'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'sub-1',
    scope: 'workspace',
    provider: 'kimi',
    title: 'Sub-thread',
    workspaceId: 'ws',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('isSubThreadDelegationMessage', () => {
  it('matches system messages with subThreadDelegation kind', () => {
    const msg: ChatMessage = {
      id: 'm',
      role: 'system',
      content: '↪ Delegated to Kimi sub-thread.',
      timestamp: 't',
      metadata: { kind: 'subThreadDelegation', subThreadId: 'sub-1' }
    }
    expect(isSubThreadDelegationMessage(msg)).toBe(true)
  })

  it('rejects messages with a different kind', () => {
    const msg: ChatMessage = {
      id: 'm',
      role: 'system',
      content: '↩ Result',
      timestamp: 't',
      metadata: { kind: 'subThreadReturn' }
    }
    expect(isSubThreadDelegationMessage(msg)).toBe(false)
  })
})

describe('resolveDelegationStatus', () => {
  it('returns running when chat is in the live running set', () => {
    const chat = makeChat()
    const status = resolveDelegationStatus(chat, new Set(['sub-1']))
    expect(status.kind).toBe('running')
  })

  it('returns created when chat has no runs yet (just-spawned)', () => {
    const chat = makeChat({ runs: [] })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('created')
  })

  it('returns completed when the last run ended successfully', () => {
    const chat = makeChat({
      runs: [{ runId: 'r', startedAt: 't', endedAt: 't+1', status: 'success' }]
    })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('completed')
  })

  it('returns returned when a successful run was propagated to the parent', () => {
    const chat = makeChat({
      delegationContext: {
        createdAt: 1,
        parentProvider: 'gemini',
        delegationPrompt: 'Do work',
        returnResultToParent: true,
        resultReturnedAt: Date.parse('2026-01-01T00:00:02Z')
      },
      runs: [
        {
          runId: 'r',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:01Z',
          status: 'success'
        }
      ]
    })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('returned')
  })

  it('returns completed when the latest successful run is newer than a prior return', () => {
    const chat = makeChat({
      delegationContext: {
        createdAt: 1,
        parentProvider: 'gemini',
        delegationPrompt: 'Do work',
        returnResultToParent: true,
        resultReturnedAt: Date.parse('2026-01-01T00:00:02Z')
      },
      runs: [
        {
          runId: 'r',
          startedAt: '2026-01-01T00:00:03Z',
          endedAt: '2026-01-01T00:00:04Z',
          status: 'success'
        }
      ]
    })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('completed')
  })

  it('returns failed when the last run failed', () => {
    const chat = makeChat({
      runs: [{ runId: 'r', startedAt: 't', endedAt: 't+1', status: 'failed' }]
    })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('failed')
  })

  it('returns cancelled when the last run was cancelled', () => {
    const chat = makeChat({
      runs: [{ runId: 'r', startedAt: 't', endedAt: 't+1', status: 'cancelled' }]
    })
    const status = resolveDelegationStatus(chat, new Set())
    expect(status.kind).toBe('cancelled')
  })

  it('returns unknown when no chat record is available', () => {
    const status = resolveDelegationStatus(undefined, new Set())
    expect(status.kind).toBe('unknown')
  })
})

describe('SubThreadDelegationCard', () => {
  it('renders TaskWraith sub-threads as agent invocations with an explicit route', () => {
    const msg: ChatMessage = {
      id: 'm',
      role: 'system',
      content: '↪ Delegated to Kimi sub-thread.',
      timestamp: 't',
      metadata: {
        kind: 'subThreadDelegation',
        subThreadId: 'sub-1',
        parentProvider: 'claude',
        subThreadProvider: 'kimi',
        subThreadTitle: 'Review helper',
        delegationPromptPreview: 'Review the changed files'
      }
    }
    const html = renderToStaticMarkup(
      <SubThreadDelegationCard message={msg} chats={[makeChat()]} onOpenSubThread={() => {}} />
    )

    expect(html).toContain('Agent Invocation')
    expect(html).not.toContain('TaskWraith Sub-thread')
    expect(html).toContain('Durable sub-thread')
    expect(html).toContain('opens as side chat')
    expect(html).toContain('Review helper')
    expect(html).toContain('provider-satellite-label provider-claude')
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).not.toContain('provider-glyph-claude')
    expect(html).toContain('provider-satellite-label provider-kimi')
    expect(html).toContain('data-provider-logo="kimi"')
    expect(html).not.toContain('provider-glyph-kimi')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).toContain('Side chat')
  })

  it('replaces the three legacy actions with one side-chat button', () => {
    const msg: ChatMessage = {
      id: 'm',
      role: 'system',
      content: '↪ Delegated to Kimi sub-thread.',
      timestamp: 't',
      metadata: {
        kind: 'subThreadDelegation',
        subThreadId: 'sub-1',
        parentProvider: 'claude',
        subThreadProvider: 'kimi',
        subThreadTitle: 'Review helper'
      }
    }
    const html = renderToStaticMarkup(
      <SubThreadDelegationCard
        message={msg}
        chats={[makeChat()]}
        onOpenSubThread={() => {}}
        onOpenSubThreadInSidePanel={() => {}}
      />
    )

    expect(html).toContain('opens as side chat')
    expect(html).toContain('Side chat')
    expect(html).not.toContain('Open beside')
    expect(html).not.toContain('Open drawer')
    expect(html).not.toContain('Open main')
  })

  it('routes the side-chat action through the side-panel callback', () => {
    const msg: ChatMessage = {
      id: 'm',
      role: 'system',
      content: '↪ Delegated to Kimi sub-thread.',
      timestamp: 't',
      metadata: {
        kind: 'subThreadDelegation',
        subThreadId: 'sub-1',
        parentProvider: 'claude',
        subThreadProvider: 'kimi',
        subThreadTitle: 'Review helper'
      }
    }
    const onOpenSubThreadInSidePanel = vi.fn()
    const stopPropagation = vi.fn()
    const tree = SubThreadDelegationCard({
      message: msg,
      chats: [makeChat()],
      onOpenSubThread: () => {},
      onOpenSubThreadInSidePanel
    })

    findClickableByClassName(tree, 'subthread-side-chat-button').props.onClick?.({
      stopPropagation
    })

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onOpenSubThreadInSidePanel).toHaveBeenCalledWith('sub-1')
  })
})
