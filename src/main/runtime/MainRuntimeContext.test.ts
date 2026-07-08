import { describe, it, expect, vi } from 'vitest'
import { createMainRuntimeContext, type MainRuntimeContext } from './MainRuntimeContext'

describe('createMainRuntimeContext', () => {
  const fakeWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as import('electron').BrowserWindow

  function makeMinimalContext(partial: Partial<Parameters<typeof createMainRuntimeContext>[0]> = {}): MainRuntimeContext {
    return createMainRuntimeContext({
      windows: {
        getMainWindow: () => fakeWindow,
        sendToRenderer: (channel, payload) => {
          const win = fakeWindow
          if (win && !win.isDestroyed()) {
            win.webContents.send(channel, payload)
          }
        },
      },
      runtime: {
        dispatchRun: async () => {},
        getRunCoordinator: () => null,
        getRunQueue: () => null,
        getRunLifecycle: () => null,
        getRunRepository: () => ({ find: () => [] }) as unknown as import('../RunRepository').RunRepository,
      },
      services: {
        getSettings: () => null,
        getApprovalService: () => null,
        getComposerService: () => null,
        getEnsembleOrchestrator: () => null,
        getWakeupTimers: () => null,
        getSessionCheckpoints: () => null,
        getAuditOrchestrator: () => null,
        getCreativeApprovalGate: () => null,
        getPluginHost: () => null,
        getPluginContributions: () => null,
        getLocalServers: () => null,
        getApnsTokenStore: () => null,
      },
      remote: {
        getBridgeBroadcaster: () => null,
        getBridgeDaemon: () => null,
        getGitSnapshotFeed: () => null,
      },
      lazy: {
        getTranscriptMediaAssetStore: () => ({}) as unknown as import('../services/TranscriptMediaAssetStore').TranscriptMediaAssetStore,
      },
      ...partial,
    } as Parameters<typeof createMainRuntimeContext>[0])
  }

  it('returns a context object with all domain groups', () => {
    const ctx = makeMinimalContext()
    expect(ctx.getMainWindow).toBeTypeOf('function')
    expect(ctx.sendToRenderer).toBeTypeOf('function')
    expect(ctx.dispatchRun).toBeTypeOf('function')
    expect(ctx.requireRunCoordinator).toBeTypeOf('function')
    expect(ctx.requireSettings).toBeTypeOf('function')
    expect(ctx.getBridgeBroadcaster).toBeTypeOf('function')
    expect(ctx.getTranscriptMediaAssetStore).toBeTypeOf('function')
  })

  it('getMainWindow returns the live window value', () => {
    const ctx = makeMinimalContext({
      windows: { getMainWindow: () => fakeWindow, sendToRenderer: () => {} },
    })
    expect(ctx.getMainWindow()).toBe(fakeWindow)
  })

  it('requireX throws NotInitializedError when getter returns null', () => {
    const ctx = makeMinimalContext({
      services: {
        getSettings: () => null,
        getApprovalService: () => null,
        getComposerService: () => null,
        getEnsembleOrchestrator: () => null,
        getWakeupTimers: () => null,
        getSessionCheckpoints: () => null,
        getAuditOrchestrator: () => null,
        getCreativeApprovalGate: () => null,
        getPluginHost: () => null,
        getPluginContributions: () => null,
        getLocalServers: () => null,
        getApnsTokenStore: () => null,
      },
    })
    expect(() => ctx.requireSettings()).toThrow('MainRuntimeContext: SettingsService has not been initialized yet')
    expect(() => ctx.requireApprovalService()).toThrow('MainRuntimeContext: ApprovalService has not been initialized yet')
  })

  it('requireX returns the service when getter returns a value', () => {
    const fakeService = { id: 'settings' } as unknown as import('../services/SettingsService').SettingsService
    const ctx = makeMinimalContext({
      services: {
        getSettings: () => fakeService,
        getApprovalService: () => null,
        getComposerService: () => null,
        getEnsembleOrchestrator: () => null,
        getWakeupTimers: () => null,
        getSessionCheckpoints: () => null,
        getAuditOrchestrator: () => null,
        getCreativeApprovalGate: () => null,
        getPluginHost: () => null,
        getPluginContributions: () => null,
        getLocalServers: () => null,
        getApnsTokenStore: () => null,
      },
    })
    expect(ctx.requireSettings()).toBe(fakeService)
  })

  it('getRunRepository never throws (lazy singleton semantics)', () => {
    const fakeRepo = { find: () => [] } as unknown as import('../RunRepository').RunRepository
    const ctx = makeMinimalContext({
      runtime: {
        dispatchRun: async () => {},
        getRunCoordinator: () => null,
        getRunQueue: () => null,
        getRunLifecycle: () => null,
        getRunRepository: () => fakeRepo,
      },
    })
    expect(() => ctx.getRunRepository()).not.toThrow()
    expect(ctx.getRunRepository()).toBe(fakeRepo)
  })

  it('getTranscriptMediaAssetStore never throws (lazy singleton semantics)', () => {
    const fakeStore = { id: 'media' } as unknown as import('../services/TranscriptMediaAssetStore').TranscriptMediaAssetStore
    const ctx = makeMinimalContext({
      lazy: { getTranscriptMediaAssetStore: () => fakeStore },
    })
    expect(() => ctx.getTranscriptMediaAssetStore()).not.toThrow()
    expect(ctx.getTranscriptMediaAssetStore()).toBe(fakeStore)
  })

  it('sendToRenderer delegates to the injected closure', () => {
    const sendFn = vi.fn()
    const ctx = makeMinimalContext({
      windows: { getMainWindow: () => null, sendToRenderer: sendFn },
    })
    ctx.sendToRenderer('test-channel', { foo: 1 })
    expect(sendFn).toHaveBeenCalledWith('test-channel', { foo: 1 })
  })
})
