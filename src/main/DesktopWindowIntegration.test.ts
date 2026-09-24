import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { DesktopWindowRegistry } from './DesktopWindowRegistry'

// Execute the real composition-root factory with Electron's lifecycle replaced
// by controllable windows. Importing index.ts would boot providers and stores.
const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const start = source.indexOf('function createWindow(): BrowserWindow {')
const end = source.indexOf('// A second launch can arrive', start)
const factory = ts.transpileModule(
  source.slice(start, end) + '\nexports.createWindow = createWindow',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

function setup() {
  let nextId = 0
  class FakeWindow extends EventEmitter {
    id = ++nextId
    destroyed = false
    show = vi.fn()
    maximize = vi.fn()
    isDestroyed = () => this.destroyed
    isMinimized = () => false
    webContents = Object.assign(new EventEmitter(), {
      id: this.id + 100,
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      getURL: () => `file:///app/${this.id}.html`,
      setWindowOpenHandler: vi.fn()
    })
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn().mockResolvedValue(undefined)
    close(): void {
      this.emit('close')
      this.destroyed = true
      this.emit('closed')
    }
  }
  const registry = new DesktopWindowRegistry()
  const noop = vi.fn()
  const context = {
    exports: {} as { createWindow: () => FakeWindow },
    BrowserWindow: FakeWindow,
    desktopWindows: registry,
    process: { platform: 'darwin', env: {} },
    is: { dev: false },
    join,
    __dirname: '/app/main',
    URL,
    console,
    startupMilestones: { mark: noop, report: noop },
    tuiHeadlessHostSession: { isHeadless: false },
    AppStore: { getSettings: () => ({}) },
    resolveNativeVibrancy: () => undefined,
    resolveInitialWindowPlacement: () => ({ width: 900, height: 700 }),
    MIN_WINDOW_WIDTH: 640,
    MIN_WINDOW_HEIGHT: 480,
    attachSpellcheckContextTracking: noop,
    deferredProjectReferenceReconciler: null,
    managedRunConfiguredProviderDiscovery: { start: noop },
    emitDueScheduledTasks: noop,
    appShellStatsService: { start: vi.fn(), stop: vi.fn() },
    isMainWindowStatsActive: () => true,
    noteFirstPaintForExternalUsagePrewarm: noop,
    broadcastStartupAuthorityState: noop,
    startupAuthorityRecoveryRef: { startAutomaticRetries: noop },
    scheduleWorkspaceLockHistoryCompaction: noop,
    schedulePersistMainWindowBounds: vi.fn(),
    persistMainWindowBounds: vi.fn(),
    updateAppShellStatsPollingMode: vi.fn(),
    canvasEmbedIpcAuthority: { closeRenderer: vi.fn().mockResolvedValue([]) },
    teardownCanvasSurfacesForWindowClose: vi.fn(),
    windowBoundsSaveTimer: null,
    applyNativeGlassToWindow: vi.fn(),
    openSafeShellTargetDetached: vi.fn(),
    rendererConsoleBuffer: [],
    consoleMessageLevelToNumber: noop
  }
  runInNewContext(factory, context)
  return { ...context, registry, create: context.exports.createWindow }
}

describe('desktop window composition', () => {
  it('shows each new window and preserves the survivor when the other closes', () => {
    const deps = setup()
    const first = deps.create()
    const second = deps.create()
    first.emit('ready-to-show')
    second.emit('ready-to-show')
    expect(first.show).toHaveBeenCalledOnce()
    expect(second.show).toHaveBeenCalledOnce()
    expect(deps.registry.all()).toHaveLength(2)
    first.emit('focus')
    first.close()
    expect(deps.registry.selected()).toBe(second)
    expect(deps.appShellStatsService.stop).not.toHaveBeenCalled()
    expect(deps.canvasEmbedIpcAuthority.closeRenderer).toHaveBeenCalledExactlyOnceWith(
      first.webContents.id
    )
    expect(deps.teardownCanvasSurfacesForWindowClose).not.toHaveBeenCalled()
    second.close()
    expect(deps.appShellStatsService.stop).toHaveBeenCalledOnce()
  })

  it('persists bounds and applies appearance to the window that emitted the event', () => {
    const deps = setup()
    const first = deps.create()
    const second = deps.create()
    second.emit('focus')
    first.emit('resize')
    first.emit('maximize')
    first.emit('blur')
    expect(deps.schedulePersistMainWindowBounds).toHaveBeenCalledWith(first)
    expect(deps.persistMainWindowBounds).toHaveBeenCalledWith(first)
    expect(deps.applyNativeGlassToWindow).toHaveBeenCalledWith(first, {})
    expect(deps.registry.selected()).toBe(second)
  })

  it('uses each window URL for navigation checks after another window is selected', () => {
    const deps = setup()
    const first = deps.create()
    deps.create()
    const event = { preventDefault: vi.fn() }
    first.webContents.emit('will-navigate', event, first.webContents.getURL() + '#section')
    expect(event.preventDefault).not.toHaveBeenCalled()
    first.webContents.emit('will-navigate', event, 'https://example.com')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(deps.openSafeShellTargetDetached).toHaveBeenCalledWith('https://example.com')
  })
})
