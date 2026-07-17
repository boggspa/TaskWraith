import { describe, expect, it } from 'vitest'

import type { WorkspaceRecord } from '../../../main/store/types'
import {
  isConvertiblePristineSingleDraft,
  pickLastOpenedWorkspace,
  planPrimarySurfaceConversion,
  primarySurfaceForSidebarTabChange,
  type ConvertibleWelcomeChatLike,
  type PrimarySurfaceConversionInput
} from './primarySurfaceToggle'

const workspace = (id: string, lastOpenedAt: number): WorkspaceRecord => ({
  id,
  path: `/repos/${id}`,
  displayName: id,
  createdAt: 1,
  lastOpenedAt,
  pinned: false
})

const pristineChat = (
  overrides: Partial<ConvertibleWelcomeChatLike> = {}
): ConvertibleWelcomeChatLike => ({
  scope: 'global',
  chatKind: 'single',
  messages: [],
  runs: [],
  ...overrides
})

const baseInput = (
  overrides: Partial<PrimarySurfaceConversionInput> = {}
): PrimarySurfaceConversionInput => ({
  surface: 'threads',
  chat: pristineChat(),
  isChatBusy: false,
  isMultiview: false,
  isWorkflowChat: false,
  hasActiveWorkspaceBoard: false,
  currentWorkspace: null,
  workspaces: [workspace('older', 100), workspace('newest', 300), workspace('middle', 200)],
  ...overrides
})

describe('primarySurfaceForSidebarTabChange', () => {
  it('reports a chat → threads change as the threads surface', () => {
    expect(primarySurfaceForSidebarTabChange('chat', 'threads')).toBe('threads')
  })

  it('reports a threads → chat change as the chat surface', () => {
    expect(primarySurfaceForSidebarTabChange('threads', 'chat')).toBe('chat')
  })

  it('treats leaving projects for a primary surface as selecting that surface', () => {
    expect(primarySurfaceForSidebarTabChange('projects', 'chat')).toBe('chat')
    expect(primarySurfaceForSidebarTabChange('projects', 'threads')).toBe('threads')
  })

  it('never fires for a re-click of the active tab', () => {
    expect(primarySurfaceForSidebarTabChange('chat', 'chat')).toBeNull()
    expect(primarySurfaceForSidebarTabChange('threads', 'threads')).toBeNull()
    expect(primarySurfaceForSidebarTabChange('projects', 'projects')).toBeNull()
  })

  it('never fires when landing on projects — sidebar only', () => {
    expect(primarySurfaceForSidebarTabChange('chat', 'projects')).toBeNull()
    expect(primarySurfaceForSidebarTabChange('threads', 'projects')).toBeNull()
  })
})

describe('pickLastOpenedWorkspace', () => {
  it('prefers the current workspace when one is set', () => {
    const current = workspace('current', 0)
    expect(pickLastOpenedWorkspace(current, [workspace('newest', 999)])).toBe(current)
  })

  it('falls back to the most recently opened workspace', () => {
    const workspaces = [workspace('older', 100), workspace('newest', 300), workspace('middle', 200)]
    expect(pickLastOpenedWorkspace(null, workspaces)?.id).toBe('newest')
  })

  it('does not mutate the caller-supplied workspace ordering', () => {
    const workspaces = [workspace('older', 100), workspace('newest', 300)]
    pickLastOpenedWorkspace(null, workspaces)
    expect(workspaces.map((ws) => ws.id)).toEqual(['older', 'newest'])
  })

  it('treats a missing lastOpenedAt as never opened', () => {
    const undated = { ...workspace('undated', 0), lastOpenedAt: undefined as unknown as number }
    expect(pickLastOpenedWorkspace(null, [undated, workspace('dated', 1)])?.id).toBe('dated')
  })

  it('returns null when nothing is registered', () => {
    expect(pickLastOpenedWorkspace(null, [])).toBeNull()
  })
})

describe('isConvertiblePristineSingleDraft', () => {
  it('accepts a pristine full-record single draft', () => {
    expect(isConvertiblePristineSingleDraft(pristineChat())).toBe(true)
  })

  it('accepts a pristine summary record — the boot-reuse shape', () => {
    expect(
      isConvertiblePristineSingleDraft(
        pristineChat({ summaryOnly: true, messageCount: 0, runCount: 0 })
      )
    ).toBe(true)
  })

  it('rejects null, ensembles, and sub-threads', () => {
    expect(isConvertiblePristineSingleDraft(null)).toBe(false)
    expect(isConvertiblePristineSingleDraft(undefined)).toBe(false)
    expect(isConvertiblePristineSingleDraft(pristineChat({ chatKind: 'ensemble' }))).toBe(false)
    expect(isConvertiblePristineSingleDraft(pristineChat({ parentChatId: 'parent' }))).toBe(false)
  })

  it('rejects conversation content and any run history', () => {
    expect(
      isConvertiblePristineSingleDraft(pristineChat({ messages: [{ role: 'assistant' }] }))
    ).toBe(false)
    expect(isConvertiblePristineSingleDraft(pristineChat({ runs: [{}] }))).toBe(false)
    expect(
      isConvertiblePristineSingleDraft(
        pristineChat({ summaryOnly: true, messageCount: 0, runCount: 2 })
      )
    ).toBe(false)
  })
})

describe('planPrimarySurfaceConversion', () => {
  it('converts a pristine General draft to a workspace draft in the last-opened workspace', () => {
    const plan = planPrimarySurfaceConversion(baseInput())
    expect(plan).toEqual({ kind: 'to-workspace', workspace: workspace('newest', 300) })
  })

  it('prefers the current workspace over recency for the Code target', () => {
    const current = workspace('current', 0)
    const plan = planPrimarySurfaceConversion(baseInput({ currentWorkspace: current }))
    expect(plan).toEqual({ kind: 'to-workspace', workspace: current })
  })

  it('converts a pristine workspace draft back to General', () => {
    const plan = planPrimarySurfaceConversion(
      baseInput({ surface: 'chat', chat: pristineChat({ scope: 'workspace' }) })
    )
    expect(plan).toEqual({ kind: 'to-global' })
  })

  it('is a no-op when the draft already lives on the selected surface', () => {
    expect(planPrimarySurfaceConversion(baseInput({ surface: 'chat' }))).toEqual({ kind: 'none' })
    expect(
      planPrimarySurfaceConversion(baseInput({ chat: pristineChat({ scope: 'workspace' }) }))
    ).toEqual({ kind: 'none' })
  })

  it('is a no-op without a registered workspace to target', () => {
    expect(planPrimarySurfaceConversion(baseInput({ workspaces: [] }))).toEqual({ kind: 'none' })
  })

  it('never converts without a focused chat', () => {
    expect(planPrimarySurfaceConversion(baseInput({ chat: null }))).toEqual({ kind: 'none' })
    expect(planPrimarySurfaceConversion(baseInput({ chat: undefined }))).toEqual({ kind: 'none' })
  })

  it('never converts an ensemble — curated panels move through their own rebind flows', () => {
    expect(
      planPrimarySurfaceConversion(baseInput({ chat: pristineChat({ chatKind: 'ensemble' }) }))
    ).toEqual({ kind: 'none' })
  })

  it('never converts a busy, multiview, workflow, or board-covered chat', () => {
    expect(planPrimarySurfaceConversion(baseInput({ isChatBusy: true }))).toEqual({ kind: 'none' })
    expect(planPrimarySurfaceConversion(baseInput({ isMultiview: true }))).toEqual({ kind: 'none' })
    expect(planPrimarySurfaceConversion(baseInput({ isWorkflowChat: true }))).toEqual({
      kind: 'none'
    })
    expect(planPrimarySurfaceConversion(baseInput({ hasActiveWorkspaceBoard: true }))).toEqual({
      kind: 'none'
    })
  })

  it('never converts a chat with conversation content', () => {
    expect(
      planPrimarySurfaceConversion(
        baseInput({ chat: pristineChat({ messages: [{ role: 'user' }] }) })
      )
    ).toEqual({ kind: 'none' })
  })

  it('never converts a sub-thread', () => {
    expect(
      planPrimarySurfaceConversion(baseInput({ chat: pristineChat({ parentChatId: 'parent' }) }))
    ).toEqual({ kind: 'none' })
  })

  it('never converts a chat with run history, even message-less aborted runs', () => {
    expect(
      planPrimarySurfaceConversion(baseInput({ chat: pristineChat({ runs: [{}] }) }))
    ).toEqual({ kind: 'none' })
    expect(
      planPrimarySurfaceConversion(
        baseInput({ chat: pristineChat({ summaryOnly: true, messageCount: 0, runCount: 1 }) })
      )
    ).toEqual({ kind: 'none' })
  })

  it('converts a pristine summary record — the boot-reuse shape', () => {
    expect(
      planPrimarySurfaceConversion(
        baseInput({ chat: pristineChat({ summaryOnly: true, messageCount: 0, runCount: 0 }) })
      )
    ).toEqual({ kind: 'to-workspace', workspace: workspace('newest', 300) })
  })
})
