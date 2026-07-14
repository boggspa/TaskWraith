import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from './run/AgentRunTypes'
import type { ChatRecord } from './store/types'
import {
  bindRuntimeWorktreeBaseWorkspace,
  derivePopoutRunPayload
} from './RendererRunAuthority'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-test-1',
    title: 'Test 1',
    scope: 'workspace',
    provider: 'codex',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    linkedProviderSessionId: 'session-test-1',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function payload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/Test 3',
    prompt: 'Read files.',
    appChatId: 'chat-test-1',
    providerSessionId: 'session-test-3',
    ...overrides
  }
}

describe('derivePopoutRunPayload', () => {
  it('derives Test 1 workspace and session instead of trusting Test 3 payload fields', () => {
    expect(
      derivePopoutRunPayload({
        payload: payload(),
        chat: chat(),
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1' },
        canonicalizePath: (path) => `/real${path}`
      })
    ).toMatchObject({
      scope: 'workspace',
      workspace: '/real/Test 1',
      providerSessionId: 'session-test-1'
    })
  })

  it('rejects a frozen popout owner that does not match the durable chat workspace', () => {
    expect(() =>
      derivePopoutRunPayload({
        payload: payload(),
        chat: chat(),
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 3' },
        canonicalizePath: (path) => path
      })
    ).toThrow('Renderer run authority does not match its owning chat.')
  })

  it('binds a selected runtime worktree to the durable chat workspace repository', () => {
    const result = derivePopoutRunPayload({
      payload: payload({
        runtimeWorktree: {
          requested: true,
          source: 'composer',
          baseWorkspacePath: '/Test 3',
          effectiveWorkspacePath: '/Test 3-worktrees/feature',
          status: 'selected'
        }
      }),
      chat: chat(),
      owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1' },
      canonicalizePath: (path) => `/real${path}`
    })

    expect(result.runtimeWorktree).toMatchObject({
      baseWorkspacePath: '/real/Test 1',
      effectiveWorkspacePath: '/Test 3-worktrees/feature'
    })
  })

  it('does not resume a foreign Gemini session', () => {
    const result = derivePopoutRunPayload({
      payload: payload({ provider: 'gemini', providerSessionId: 'gemini-test-3' }),
      chat: chat({
        provider: 'gemini',
        linkedProviderSessionId: undefined,
        linkedGeminiSessionId: 'gemini-test-1'
      }),
      owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1' },
      canonicalizePath: (path) => path
    })

    expect(result.providerSessionId).toBeNull()
  })

  it('derives global scope without accepting a renderer workspace', () => {
    expect(
      derivePopoutRunPayload({
        payload: payload({ scope: 'workspace', workspace: '/Test 3' }),
        chat: chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }),
        owner: { kind: 'chat', chatId: 'chat-test-1' },
        canonicalizePath: (path) => path
      })
    ).toMatchObject({ scope: 'global', workspace: undefined, runtimeWorktree: undefined })
  })

  it('rejects a stale workspace owner after its durable chat is rebound to global', () => {
    expect(() =>
      derivePopoutRunPayload({
        payload: payload({ scope: 'global', workspace: undefined }),
        chat: chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }),
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1' },
        canonicalizePath: (path) => path
      })
    ).toThrow('Renderer run authority does not match its owning chat.')
  })
})

describe('bindRuntimeWorktreeBaseWorkspace', () => {
  const canonicalizePath = (path: string): string => path.replace(/\/$/, '')

  it('rejects a main-renderer Test 1 run that nominates registered Test 3 as its base', () => {
    expect(() =>
      bindRuntimeWorktreeBaseWorkspace({
        requestedBaseWorkspacePath: '/Test 3',
        registeredWorkspace: '/Test 1',
        canonicalizePath
      })
    ).toThrow('does not match the run chat workspace')
  })

  it('accepts the already chat-bound workspace as the runtime worktree base', () => {
    expect(
      bindRuntimeWorktreeBaseWorkspace({
        requestedBaseWorkspacePath: '/Test 1/',
        registeredWorkspace: '/Test 1',
        canonicalizePath
      })
    ).toBe('/Test 1')
  })
})
