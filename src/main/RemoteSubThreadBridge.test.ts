import { describe, expect, it, vi } from 'vitest'
import type { BridgeCreateSubThreadAction } from './BridgeActionPayload'
import {
  createRemoteSubThread,
  type RemoteSubThreadBridgeDependencies
} from './RemoteSubThreadBridge'
import type { ChatRecord, ProviderId } from './store/types'

const action: BridgeCreateSubThreadAction = {
  kind: 'createSubThread',
  workspaceId: 'ws-1',
  threadId: 'parent-1',
  provider: 'codex',
  prompt: 'Investigate the failing renderer test.',
  returnResult: true
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'parent-1',
    provider: 'claude',
    scope: 'workspace',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    title: 'Parent',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChatRecord
}

function dependencies(overrides: Partial<RemoteSubThreadBridgeDependencies> = {}) {
  const parent = chat()
  const child = chat({
    appChatId: 'child-1',
    provider: 'codex',
    parentChatId: parent.appChatId,
    parentChatRelation: 'subThread'
  })
  return {
    parent,
    child,
    deps: {
      getChat: vi.fn(() => parent),
      canonicalWorkspaceId: vi.fn((workspaceId) => workspaceId ?? null),
      globalWorkspaceId: 'global',
      assertLiveProviderId: vi.fn((provider) => provider as ProviderId),
      createSubThread: vi.fn(() => child),
      broadcastChatUpdated: vi.fn(),
      broadcastThreadUpdate: vi.fn(),
      pushRemoteThreadSnapshot: vi.fn(),
      ...overrides
    } satisfies RemoteSubThreadBridgeDependencies
  }
}

describe('createRemoteSubThread', () => {
  it('creates a durable child through ChatService and publishes it', () => {
    const { child, deps } = dependencies()

    expect(createRemoteSubThread(action, deps)).toEqual({ ok: true, threadId: 'child-1' })
    expect(deps.createSubThread).toHaveBeenCalledWith({
      parentChatId: 'parent-1',
      provider: 'codex',
      delegationPrompt: action.prompt,
      returnResultToParent: true
    })
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(child)
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('child-1')
    expect(deps.pushRemoteThreadSnapshot).toHaveBeenCalledWith(child, 'ws-1')
  })

  it('refuses a parent outside the authenticated remote workspace', () => {
    const { deps } = dependencies()

    expect(createRemoteSubThread({ ...action, workspaceId: 'ws-2' }, deps)).toEqual({
      ok: false,
      error: 'Parent thread does not belong to this workspace'
    })
    expect(deps.createSubThread).not.toHaveBeenCalled()
  })

  it('maps a genuinely global parent to the global remote scope', () => {
    const parent = chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    const { deps } = dependencies({ getChat: vi.fn(() => parent) })

    expect(
      createRemoteSubThread({ ...action, workspaceId: 'global', threadId: parent.appChatId }, deps)
    ).toEqual({ ok: true, threadId: 'child-1' })
  })

  it('does not misclassify a stale workspace id as global', () => {
    const parent = chat({ workspaceId: 'removed-workspace' })
    const { deps } = dependencies({
      getChat: vi.fn(() => parent),
      canonicalWorkspaceId: vi.fn(() => null)
    })

    expect(
      createRemoteSubThread({ ...action, workspaceId: 'global', threadId: parent.appChatId }, deps)
    ).toEqual({ ok: false, error: 'Parent thread does not belong to this workspace' })
    expect(deps.createSubThread).not.toHaveBeenCalled()
  })

  it('surfaces live-provider and relationship refusals without publishing', () => {
    const { deps } = dependencies({
      assertLiveProviderId: vi.fn(() => {
        throw new Error('Provider is not live')
      })
    })

    expect(createRemoteSubThread(action, deps)).toEqual({
      ok: false,
      error: 'Provider is not live'
    })
    expect(deps.createSubThread).not.toHaveBeenCalled()
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
  })
})
