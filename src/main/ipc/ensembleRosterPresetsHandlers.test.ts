import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  getCachedRemoteEnsemblePresets,
  setRemoteEnsemblePresetsFromRaw
} from '../remote/EnsembleRosterPresetsCache'
import {
  registerEnsembleRosterPresetsHandlers,
  type EnsembleRosterPresetsHandlerDeps
} from './ensembleRosterPresetsHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
  // The cache module is a real (non-electron) singleton shared across tests in
  // this file, so start each test from a clean slate rather than mocking it.
  setRemoteEnsemblePresetsFromRaw([])
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
    onChanged: vi.fn<EnsembleRosterPresetsHandlerDeps['onChanged']>()
  } satisfies EnsembleRosterPresetsHandlerDeps
}

describe('registerEnsembleRosterPresetsHandlers', () => {
  it('registers the ensemble-roster-presets:sync channel', () => {
    registerEnsembleRosterPresetsHandlers(createDeps())
    expect(handlerFor('ensemble-roster-presets:sync')).toBeTypeOf('function')
  })

  it('projects a synced preset list into the cache and notifies onChanged', () => {
    const deps = createDeps()
    registerEnsembleRosterPresetsHandlers(deps)

    handlerFor('ensemble-roster-presets:sync')({}, [
      {
        id: 'preset-1',
        name: 'Review panel',
        participants: [{ provider: 'codex', enabled: true, role: 'Builder', order: 1 }]
      }
    ])

    expect(getCachedRemoteEnsemblePresets()).toEqual([
      {
        id: 'preset-1',
        name: 'Review panel',
        participants: [
          {
            id: 'preset-1-p1',
            provider: 'codex',
            role: 'Builder',
            enabled: true,
            order: 1
          }
        ]
      }
    ])
    expect(deps.onChanged).toHaveBeenCalledTimes(1)
  })

  it('clears the cache to an empty array for malformed payloads but still notifies onChanged', () => {
    const deps = createDeps()
    setRemoteEnsemblePresetsFromRaw([{ id: 'stale', name: 'Stale', participants: [] }])
    registerEnsembleRosterPresetsHandlers(deps)

    handlerFor('ensemble-roster-presets:sync')({}, 'not-an-array')

    expect(getCachedRemoteEnsemblePresets()).toEqual([])
    expect(deps.onChanged).toHaveBeenCalledTimes(1)
  })
})
