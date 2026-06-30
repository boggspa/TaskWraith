import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings } from '../store/types'
import { registerAppearanceHandlers } from './appearanceHandlers'

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

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    appearanceMode: 'soft_glass',
    reduceTransparency: false,
    ...overrides
  } as unknown as AppSettings
}

function createDeps() {
  const mainWindow = { isDestroyed: () => false } as unknown as BrowserWindow
  const popoutWindow = { isDestroyed: () => false } as unknown as BrowserWindow
  const destroyedPopout = { isDestroyed: () => true } as unknown as BrowserWindow
  const settings = createSettings()

  return {
    settings,
    mainWindow,
    popoutWindow,
    destroyedPopout,
    deps: {
      getSettings: vi.fn(() => settings),
      isAppearanceMode: (value: unknown): value is AppSettings['appearanceMode'] =>
        value === 'soft_glass' || value === 'solid',
      getMainWindow: vi.fn(() => mainWindow),
      forEachWorkspacePopoutWindow: vi.fn((visit: (window: BrowserWindow) => void) => {
        visit(popoutWindow)
        visit(destroyedPopout)
      }),
      applyNativeGlassToWindow: vi.fn(),
      getCachedHostWeather: vi.fn(async () => ({ condition: 'sunny' })),
      getNativeCapabilitySnapshot: vi.fn(() => ({ bridge: { available: true } }))
    }
  }
}

describe('registerAppearanceHandlers', () => {
  it('registers appearance and host capability IPC channels', () => {
    registerAppearanceHandlers(createDeps().deps)

    expect(handlerFor('set-appearance-mode')).toBeTypeOf('function')
    expect(handlerFor('get-host-weather')).toBeTypeOf('function')
    expect(handlerFor('native-capabilities:snapshot')).toBeTypeOf('function')
  })

  it('applies native glass for string payloads without changing reduceTransparency', () => {
    const { deps, settings, mainWindow, popoutWindow, destroyedPopout } = createDeps()
    registerAppearanceHandlers(deps)

    expect(handlerFor('set-appearance-mode')({}, 'solid')).toBe(true)
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledTimes(2)
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({
        appearanceMode: 'solid',
        reduceTransparency: settings.reduceTransparency
      })
    )
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      popoutWindow,
      expect.objectContaining({
        appearanceMode: 'solid',
        reduceTransparency: settings.reduceTransparency
      })
    )
    expect(deps.applyNativeGlassToWindow).not.toHaveBeenCalledWith(
      destroyedPopout,
      expect.anything()
    )
  })

  it('uses nullish fallback for reduceTransparency on object payloads', () => {
    const { deps } = createDeps()
    registerAppearanceHandlers(deps)

    handlerFor('set-appearance-mode')({}, { mode: 'solid' })
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appearanceMode: 'solid',
        reduceTransparency: false
      })
    )

    deps.applyNativeGlassToWindow.mockClear()
    handlerFor('set-appearance-mode')({}, { mode: 'solid', reduceTransparency: true })
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appearanceMode: 'solid',
        reduceTransparency: true
      })
    )
  })

  it('falls back to settings.appearanceMode or soft_glass for invalid modes', () => {
    const { deps, settings } = createDeps()
    settings.appearanceMode = 'solid' as AppSettings['appearanceMode']
    registerAppearanceHandlers(deps)

    handlerFor('set-appearance-mode')({}, { mode: 'invalid' })
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appearanceMode: 'solid' })
    )

    deps.applyNativeGlassToWindow.mockClear()
    settings.appearanceMode = undefined as unknown as AppSettings['appearanceMode']
    handlerFor('set-appearance-mode')({}, { mode: 'invalid' })
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appearanceMode: 'soft_glass' })
    )
  })

  it('passes through host weather and native capability reads', async () => {
    const { deps } = createDeps()
    registerAppearanceHandlers(deps)

    await expect(handlerFor('get-host-weather')({})).resolves.toEqual({ condition: 'sunny' })
    expect(handlerFor('native-capabilities:snapshot')({})).toEqual({ bridge: { available: true } })
  })
})
