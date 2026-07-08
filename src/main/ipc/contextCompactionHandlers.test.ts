import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerContextCompactionHandlers,
  type ContextCompactionHandlersDeps
} from './contextCompactionHandlers'

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

function createDeps() {
  return {
    compactProviderContext: vi.fn<ContextCompactionHandlersDeps['compactProviderContext']>(
      async () => ({ ok: true })
    ),
    requireNonEmptyString: vi.fn<ContextCompactionHandlersDeps['requireNonEmptyString']>(
      (value, label) => {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`${label} required`)
        }
        return value.trim()
      }
    )
  } satisfies ContextCompactionHandlersDeps
}

describe('registerContextCompactionHandlers', () => {
  it('registers the compact-provider-context channel', () => {
    registerContextCompactionHandlers(createDeps())
    expect(handlerFor('compact-provider-context')).toBeTypeOf('function')
  })

  it('validates chatId and provider with the expected labels', async () => {
    const deps = createDeps()
    registerContextCompactionHandlers(deps)

    await expect(
      handlerFor('compact-provider-context')({}, { chatId: '', provider: 'codex' })
    ).rejects.toThrow('Chat id required')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('', 'Chat id')

    await expect(
      handlerFor('compact-provider-context')({}, { chatId: 'chat-1', provider: '' })
    ).rejects.toThrow('Provider required')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('', 'Provider')
  })

  it('rejects providers outside the manual-compaction whitelist without calling compactProviderContext', async () => {
    const deps = createDeps()
    registerContextCompactionHandlers(deps)

    await expect(
      handlerFor('compact-provider-context')({}, { chatId: 'chat-1', provider: 'gemini' })
    ).resolves.toEqual({
      ok: false,
      error: 'Manual context compaction is not supported for gemini.'
    })
    expect(deps.compactProviderContext).not.toHaveBeenCalled()
  })

  it('compacts for a whitelisted provider and passes chatId/provider through with no optional fields', async () => {
    const deps = createDeps()
    registerContextCompactionHandlers(deps)

    await expect(
      handlerFor('compact-provider-context')({}, { chatId: 'chat-1', provider: 'codex' })
    ).resolves.toEqual({ ok: true })
    expect(deps.compactProviderContext).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'codex',
      providerSessionId: undefined,
      participantId: undefined
    })
  })

  it('trims and forwards providerSessionId/participantId when present, omitting blank values', async () => {
    const deps = createDeps()
    registerContextCompactionHandlers(deps)

    await handlerFor('compact-provider-context')(
      {},
      {
        chatId: 'chat-1',
        provider: 'kimi',
        providerSessionId: '  sess-42  ',
        participantId: '   '
      }
    )

    expect(deps.compactProviderContext).toHaveBeenCalledWith({
      chatId: 'chat-1',
      provider: 'kimi',
      providerSessionId: 'sess-42',
      participantId: undefined
    })
  })
})
