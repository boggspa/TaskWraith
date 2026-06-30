import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerDiscordContextHandlers } from './discordContextHandlers'

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
    listTargets: vi.fn(async () => ({ targets: ['general'] })),
    readChannel: vi.fn(async (input: unknown) => ({ snapshot: input }))
  }
}

describe('registerDiscordContextHandlers', () => {
  it('registers discord context IPC channels', () => {
    registerDiscordContextHandlers(createDeps())

    expect(handlerFor('discord-context:list-targets')).toBeTypeOf('function')
    expect(handlerFor('discord-context:read-channel')).toBeTypeOf('function')
  })

  it('delegates list-targets to discordContextService', async () => {
    const deps = createDeps()
    registerDiscordContextHandlers(deps)

    await expect(handlerFor('discord-context:list-targets')({})).resolves.toEqual({
      targets: ['general']
    })
    expect(deps.listTargets).toHaveBeenCalledOnce()
  })

  it('passes read-channel input through unchanged', async () => {
    const deps = createDeps()
    registerDiscordContextHandlers(deps)
    const input = { guildId: 'guild-1', channelId: 'channel-1', limit: 20 }

    await expect(handlerFor('discord-context:read-channel')({}, input)).resolves.toEqual({
      snapshot: input
    })
    expect(deps.readChannel).toHaveBeenCalledWith(input)
  })
})
