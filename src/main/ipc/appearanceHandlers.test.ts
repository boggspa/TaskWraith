import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AppSettings } from '../store/types'
import { registerAppearanceHandlers } from './appearanceHandlers'
import { SYSTEM_ACCENT_COLOR_CHANNEL } from '../../shared/systemAccentColor'

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
      getNativeCapabilitySnapshot: vi.fn(() => ({ bridge: { available: true } })),
      getSystemAccentColor: vi.fn(() => '#1E90FF' as string | null)
    }
  }
}

describe('registerAppearanceHandlers', () => {
  it('registers appearance and host capability IPC channels', () => {
    registerAppearanceHandlers(createDeps().deps)

    expect(handlerFor('set-appearance-mode')).toBeTypeOf('function')
    expect(handlerFor('get-host-weather')).toBeTypeOf('function')
    expect(handlerFor('native-capabilities:snapshot')).toBeTypeOf('function')
    expect(handlerFor('appearance:get-system-accent-color')).toBeTypeOf('function')
  })

  it('handles the exact channel preload invokes', () => {
    // The handler spells this channel as a literal so the build-time IPC-schema
    // scan can resolve it; this is what stops the two copies drifting apart.
    registerAppearanceHandlers(createDeps().deps)

    expect(SYSTEM_ACCENT_COLOR_CHANNEL).toBe('appearance:get-system-accent-color')
    expect(handlerFor(SYSTEM_ACCENT_COLOR_CHANNEL)).toBeTypeOf('function')
  })

  it('serves the host OS accent colour the renderer applies to --accent', () => {
    const { deps } = createDeps()
    registerAppearanceHandlers(deps)

    expect(handlerFor('appearance:get-system-accent-color')({})).toBe('#1E90FF')
    expect(deps.getSystemAccentColor).toHaveBeenCalled()
  })

  it('passes a missing OS accent straight through as null', () => {
    // null is the renderer's signal to leave --accent alone so the active
    // theme's own accent wins; it must not be coerced to a colour here.
    const { deps } = createDeps()
    vi.mocked(deps.getSystemAccentColor).mockReturnValue(null)
    registerAppearanceHandlers(deps)

    expect(handlerFor('appearance:get-system-accent-color')({})).toBeNull()
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
