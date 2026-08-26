import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ComposerInput, ComposerRunPayload } from '../services/ComposerService'
import { registerComposeRunHandlers, type ComposeRunHandlersDeps } from './composeRunHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps(): ComposeRunHandlersDeps {
  return {
    composeRun: vi.fn(async () => ({ provider: 'codex' }) as ComposerRunPayload),
    requireNonEmptyString: vi.fn((value: unknown, label: string) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} required`)
      return value.trim()
    }),
    resolveSenderComposeAuthority: vi.fn((_event, input) => ({ input })),
    resolveSenderAttachmentPaths: vi.fn((_event, paths) => paths),
    assertSenderChatScope: vi.fn()
  }
}

function inputFor(chatId: string, snapshotChatId = chatId): ComposerInput {
  return {
    chatId,
    userInput: 'Run a scoped task.',
    chatSnapshot: {
      appChatId: snapshotChatId
    } as ComposerInput['chatSnapshot']
  }
}

describe('registerComposeRunHandlers', () => {
  it('registers compose-run and preserves unrestricted main-renderer targeting', async () => {
    const mainEvent = { sender: { id: 1 } }
    const deps = createDeps()
    registerComposeRunHandlers(deps)
    const input = inputFor('chat-test-3')

    await expect(handlerFor('compose-run')(mainEvent, input)).resolves.toEqual({
      provider: 'codex'
    })
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(mainEvent, 'chat-test-3')
    expect(deps.resolveSenderComposeAuthority).toHaveBeenCalledWith(mainEvent, input)
    expect(deps.composeRun).toHaveBeenCalledWith(input)
  })

  it('rejects a Test 1 popout composing a Test 3 chat before ComposerService', async () => {
    const test1Popout = { sender: { id: 11 } }
    const deps = createDeps()
    deps.assertSenderChatScope = vi.fn((_event, chatId) => {
      if (chatId !== 'chat-test-1') throw new Error('Renderer chat ownership mismatch.')
    })
    registerComposeRunHandlers(deps)

    await expect(handlerFor('compose-run')(test1Popout, inputFor('chat-test-3'))).rejects.toThrow(
      'Renderer chat ownership mismatch.'
    )
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(test1Popout, 'chat-test-3')
    expect(deps.composeRun).not.toHaveBeenCalled()
  })

  it('rejects a payload whose chat snapshot belongs to a different chat before ComposerService', async () => {
    const deps = createDeps()
    registerComposeRunHandlers(deps)

    await expect(
      handlerFor('compose-run')({ sender: { id: 1 } }, inputFor('chat-test-1', 'chat-test-3'))
    ).rejects.toThrow('Composer chat snapshot does not match the requested chat.')
    expect(deps.composeRun).not.toHaveBeenCalled()
  })

  it('rejects a Test 1 popout using a Test 3 attachment before ComposerService', async () => {
    const test1Popout = { sender: { id: 11 } }
    const deps = createDeps()
    deps.resolveSenderAttachmentPaths = vi.fn(() => {
      throw new Error('Renderer is not authorized to use one or more attachments.')
    })
    registerComposeRunHandlers(deps)
    const input = {
      ...inputFor('chat-test-1'),
      imageAttachments: [{ path: '/Test 3/secret.pdf', name: 'secret.pdf' }]
    }

    await expect(handlerFor('compose-run')(test1Popout, input)).rejects.toThrow(
      'Renderer is not authorized to use one or more attachments.'
    )
    expect(deps.resolveSenderAttachmentPaths).toHaveBeenCalledWith(test1Popout, [
      '/Test 3/secret.pdf'
    ])
    expect(deps.composeRun).not.toHaveBeenCalled()
  })

  it('passes canonical caller-authorized attachments to ComposerService', async () => {
    const deps = createDeps()
    deps.resolveSenderAttachmentPaths = vi.fn((_event, paths) =>
      paths.map((path) => `/real${path}`)
    )
    registerComposeRunHandlers(deps)
    const input = {
      ...inputFor('chat-test-1'),
      imageAttachments: [{ path: '/Test 1/allowed.png', name: 'allowed.png' }]
    }

    await handlerFor('compose-run')({ sender: { id: 11 } }, input)

    expect(deps.composeRun).toHaveBeenCalledWith({
      ...input,
      imageAttachments: [{ path: '/real/Test 1/allowed.png', name: 'allowed.png' }]
    })
  })

  it('capability-checks folder references without changing their attachment kind', async () => {
    const deps = createDeps()
    deps.resolveSenderAttachmentPaths = vi.fn((_event, paths) =>
      paths.map((path) => `/real${path}`)
    )
    registerComposeRunHandlers(deps)
    const input = {
      ...inputFor('chat-test-1'),
      imageAttachments: [
        {
          path: '/Test 1/reference-folder',
          name: 'reference-folder',
          kind: 'directory' as const
        },
        { path: '/Test 1/allowed.png', name: 'allowed.png' }
      ]
    }
    const event = { sender: { id: 11 } }

    await handlerFor('compose-run')(event, input)

    expect(deps.resolveSenderAttachmentPaths).toHaveBeenCalledWith(event, [
      '/Test 1/reference-folder',
      '/Test 1/allowed.png'
    ])
    expect(deps.composeRun).toHaveBeenCalledWith({
      ...input,
      imageAttachments: [
        {
          path: '/real/Test 1/reference-folder',
          name: 'reference-folder',
          kind: 'directory'
        },
        { path: '/real/Test 1/allowed.png', name: 'allowed.png' }
      ]
    })
  })

  it('composes only the durable chat/workspace returned by main authority', async () => {
    const deps = createDeps()
    const input = {
      ...inputFor('chat-test-1'),
      scope: 'workspace' as const,
      workspace: '/Test 3'
    }
    const durableChat = {
      ...input.chatSnapshot,
      appChatId: 'chat-test-1',
      scope: 'workspace' as const,
      workspaceId: 'workspace-test-1',
      workspacePath: '/Test 1'
    } as ComposerInput['chatSnapshot']
    deps.resolveSenderComposeAuthority = vi.fn((_event, raw) => ({
      input: {
        ...raw,
        scope: 'workspace',
        workspace: '/Test 1',
        chatSnapshot: durableChat
      }
    }))
    registerComposeRunHandlers(deps)

    await handlerFor('compose-run')({ sender: { id: 11 } }, input)

    expect(deps.composeRun).toHaveBeenCalledWith({
      ...input,
      workspace: '/Test 1',
      chatSnapshot: durableChat
    })
  })

  it('rejects scheduled provenance before composing', async () => {
    const deps = createDeps()
    deps.resolveSenderComposeAuthority = vi.fn(() => {
      throw new Error(
        'Scheduled occurrence does not match this chat, workspace, run, or dispatch mode.'
      )
    })
    registerComposeRunHandlers(deps)

    await expect(
      handlerFor('compose-run')(
        { sender: { id: 11 } },
        {
          ...inputFor('chat-test-1'),
          appRunId: 'run-replayed',
          scheduledTaskId: 'scheduled-test-3'
        }
      )
    ).rejects.toThrow('Scheduled occurrence does not match')
    expect(deps.composeRun).not.toHaveBeenCalled()
  })

  it('uses canonical scheduled attachments after exact main-owned occurrence validation', async () => {
    const deps = createDeps()
    const input = {
      ...inputFor('chat-test-1'),
      appRunId: 'run-test-1',
      scheduledTaskId: 'scheduled-test-1',
      imageAttachments: [{ path: '/forged/secret.png' }]
    }
    deps.resolveSenderComposeAuthority = vi.fn((_event, raw) => ({
      input: {
        ...raw,
        imageAttachments: [{ path: '/main-cas/scheduled.png', name: 'scheduled.png' }]
      },
      mainOwnedAttachments: true
    }))
    registerComposeRunHandlers(deps)

    await handlerFor('compose-run')({ sender: { id: 1 } }, input)

    expect(deps.resolveSenderAttachmentPaths).not.toHaveBeenCalled()
    expect(deps.composeRun).toHaveBeenCalledWith({
      ...input,
      imageAttachments: [{ path: '/main-cas/scheduled.png', name: 'scheduled.png' }]
    })
  })

  it('uses exact main-owned queued attachments without a replacement renderer receipt', async () => {
    const deps = createDeps()
    const input = {
      ...inputFor('chat-test-1'),
      appRunId: 'run-queued',
      imageAttachments: [{ path: '/forged/secret.png' }]
    }
    deps.resolveSenderComposeAuthority = vi.fn((_event, raw) => ({
      input: {
        ...raw,
        imageAttachments: [{ path: '/main-cas/queued.png', name: 'queued.png' }]
      },
      mainOwnedAttachments: true
    }))
    registerComposeRunHandlers(deps)

    await handlerFor('compose-run')({ sender: { id: 1 } }, input)

    expect(deps.resolveSenderAttachmentPaths).not.toHaveBeenCalled()
    expect(deps.composeRun).toHaveBeenCalledWith({
      ...input,
      imageAttachments: [{ path: '/main-cas/queued.png', name: 'queued.png' }]
    })
    expect(deps.onScheduledRunComposed).toBeUndefined()
  })

  it('issues a dispatch receipt only after canonical scheduled composition succeeds', async () => {
    const deps = createDeps()
    const composed = { provider: 'codex' } as ComposerRunPayload
    const event = { sender: { id: 1 } }
    const input = {
      ...inputFor('chat-test-1'),
      appRunId: 'run-test-1',
      scheduledTaskId: 'scheduled-test-1'
    }
    deps.composeRun = vi.fn(async () => composed)
    deps.resolveSenderComposeAuthority = vi.fn((_event, raw) => ({
      input: raw,
      mainOwnedAttachments: true
    }))
    deps.onScheduledRunComposed = vi.fn()
    registerComposeRunHandlers(deps)

    await expect(handlerFor('compose-run')(event, input)).resolves.toBe(composed)
    expect(deps.onScheduledRunComposed).toHaveBeenCalledWith(event, input, composed)
  })
})
