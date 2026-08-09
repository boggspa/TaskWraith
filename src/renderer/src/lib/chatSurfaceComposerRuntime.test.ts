import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildDetachedChatSurfaceBase,
  ChatSurfaceComposerRuntime,
  ChatSurfaceComposerRuntimeRegistry
} from './chatSurfaceComposerRuntime'

describe('buildDetachedChatSurfaceBase', () => {
  it('removes focused identity, mutable state, refs, and actions', () => {
    const setFocusedChat = vi.fn()
    const focusedRef = { current: 'focused-chat' }
    const detached = buildDetachedChatSurfaceBase({
      currentChatIdRef: focusedRef,
      currentGoalModeLabel: 'Focused goal',
      composerSlashCommands: [{ command: '/focused' }],
      pendingApprovalQueueByChatId: { focused: [{ id: 'approval' }] },
      multiview: { layout: 'quad', focusedPaneIndex: 2 },
      setCurrentChat: setFocusedChat,
      workflowDraft: { chatId: 'focused' },
      workspaceDiffStats: { filesChanged: 8, additions: 80, deletions: 2 }
    })

    expect(detached.currentChatIdRef).not.toBe(focusedRef)
    expect(detached.currentChatIdRef.current).toBeNull()
    expect(detached.currentGoalModeLabel).toBe('')
    expect(detached.composerSlashCommands).toEqual([])
    expect(detached.pendingApprovalQueueByChatId).toEqual({})
    expect(detached.multiview).toEqual({ layout: 'single' })
    expect(detached.workflowDraft).toBeNull()
    expect(detached.workspaceDiffStats).toEqual({ filesChanged: 0, additions: 0, deletions: 0 })
    detached.setCurrentChat({ appChatId: 'other' })
    expect(setFocusedChat).not.toHaveBeenCalled()
  })

  it('lets a runtime ignore focused-thread churn after detachment', () => {
    const runtime = new ChatSurfaceComposerRuntime<Record<string, unknown>>()
    const first = runtime.stabilize(
      buildDetachedChatSurfaceBase({
        settings: { theme: 'dark' },
        currentGoalModeLabel: 'First goal',
        queuedRunQueueCount: 1,
        setCurrentChat: vi.fn()
      })
    )
    const second = runtime.stabilize(
      buildDetachedChatSurfaceBase({
        settings: first.settings,
        currentGoalModeLabel: 'Second goal',
        queuedRunQueueCount: 9,
        setCurrentChat: vi.fn()
      })
    )

    expect(second).toBe(first)
  })
})

describe('ChatSurfaceComposerRuntime', () => {
  it('reuses an equivalent projection and dispatches through the latest handler', () => {
    const firstRun = vi.fn()
    const secondRun = vi.fn()
    const runtime = new ChatSurfaceComposerRuntime<{
      chatId: string
      onRun: () => void
      rows: string[]
      telemetry: { tokens: number }
    }>()
    const first = runtime.stabilize({
      chatId: 'chat-a',
      onRun: firstRun,
      rows: [],
      telemetry: { tokens: 12 }
    })
    const second = runtime.stabilize({
      chatId: 'chat-a',
      onRun: secondRun,
      rows: [],
      telemetry: { tokens: 12 }
    })

    expect(second).toBe(first)
    expect(second.onRun).toBe(first.onRun)
    second.onRun()
    expect(firstRun).not.toHaveBeenCalled()
    expect(secondRun).toHaveBeenCalledOnce()
  })

  it('publishes a new projection when surface-owned data changes', () => {
    const runtime = new ChatSurfaceComposerRuntime<{ chatId: string; tokens: number }>()
    const first = runtime.stabilize({ chatId: 'chat-a', tokens: 12 })
    const changed = runtime.stabilize({ chatId: 'chat-a', tokens: 13 })

    expect(changed).not.toBe(first)
    expect(changed.tokens).toBe(13)
  })
})

describe('ChatSurfaceComposerRuntimeRegistry', () => {
  it('keeps pane identities isolated and releases panes that no longer exist', () => {
    const registry = new ChatSurfaceComposerRuntimeRegistry<{
      chatId: string
      onRun: () => void
    }>()
    const paneA = registry.stabilize('pane-a', { chatId: 'chat-a', onRun: vi.fn() })
    const paneB = registry.stabilize('pane-b', { chatId: 'chat-b', onRun: vi.fn() })

    expect(registry.stabilize('pane-a', { chatId: 'chat-a', onRun: vi.fn() })).toBe(paneA)
    expect(registry.stabilize('pane-b', { chatId: 'chat-b', onRun: vi.fn() })).toBe(paneB)
    expect(paneA).not.toBe(paneB)
    expect(registry.size()).toBe(2)

    registry.retain(['pane-b'])
    expect(registry.size()).toBe(1)
    expect(registry.stabilize('pane-a', { chatId: 'chat-a', onRun: vi.fn() })).not.toBe(paneA)
  })

  it('is the identity boundary for every resting Multiview pane', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

    expect(source).toContain(
      'paneComposerRuntimeRegistryRef.current.stabilize(\n        surfaceId,\n        ctx\n      )'
    )
    expect(source).toContain('const surfaceId = multiview.panes[paneIndex]?.id')
    expect(source).toContain('multiview: { layout: multiview.layout }')
    expect(source).toContain('...detachedComposerSurfaceBase')
    expect(source).toContain('composerSurfaceBase: detachedComposerSurfaceBase')
    expect(source).toContain('const fresh = buildPaneComposerCtx(viewerChatId, viewerPaneIndex)')
    expect(source).not.toContain('const buildFallbackPaneComposerCtx')
    expect(source.match(/const paneComposerCtx: ComposerProps/g)).toHaveLength(1)
  })
})
