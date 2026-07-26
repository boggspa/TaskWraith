import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { RUN_MANAGER_PROVIDERS } from './index.constants'
import { isActiveRunSessionStatus, RunManager } from './RunManager'
import type { ProviderId } from './store/types'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'

const HEADLESS_LIVE_PROVIDERS = [...LIVE_SELECTABLE_PROVIDER_IDS, 'antigravity'] as const
const ALL_PROVIDER_IDENTITIES = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
] as const satisfies readonly ProviderId[]

/**
 * Source contract for user-note-20260723001127: when the last window closes,
 * active provider runs must continue headlessly (all providers). Teardown of
 * Codex/Gemini processes + the shared TaskWraith MCP broker must not fire
 * merely because the renderer is gone while RunManager still owns work.
 */
describe('window-all-closed headless continuity', () => {
  const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  const windowAllClosedHandler = (): string => {
    const start = indexSource.indexOf("app.on('window-all-closed'")
    expect(start).toBeGreaterThanOrEqual(0)
    // Handler ends at the next top-level `app.on` sibling or the outer block close.
    const after = indexSource.slice(start)
    const endRel = after.indexOf("app.on('activate'")
    // activate is registered *before* window-all-closed in current source; use
    // the closing of the whenReady-adjacent app listeners block instead.
    const end = after.indexOf('\n  })\n}\n')
    expect(end).toBeGreaterThan(0)
    void endRel
    return after.slice(0, end)
  }

  const sourceBetween = (startMarker: string, endMarker: string): string => {
    const start = indexSource.indexOf(startMarker)
    const end = indexSource.indexOf(endMarker, start + startMarker.length)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return indexSource.slice(start, end)
  }

  it('keeps provider sessions + MCP broker when active runs exist', () => {
    const handler = windowAllClosedHandler()
    expect(handler).toContain('getActiveTaskWraithThreadCount() > 0')
    expect(handler).toContain('hasActiveStreamingTaskWraithRun()')
    expect(handler).toContain('keepActiveRunsAlive')
    expect(handler).toContain('keepBridgeAlive || keepActiveRunsAlive')
    // Early return must precede the destructive teardown symbols.
    const keepIdx = handler.indexOf('keepActiveRunsAlive')
    const killCodexIdx = handler.indexOf('codexExecProcess.kill')
    const closeBrokerIdx = handler.indexOf('closeGeminiMcpBroker')
    expect(keepIdx).toBeGreaterThanOrEqual(0)
    expect(killCodexIdx).toBeGreaterThan(keepIdx)
    expect(closeBrokerIdx).toBeGreaterThan(keepIdx)
    // The keep-alive branch must return before those teardowns.
    const returnAfterKeep = handler.indexOf('return', keepIdx)
    expect(returnAfterKeep).toBeGreaterThan(keepIdx)
    expect(returnAfterKeep).toBeLessThan(killCodexIdx)
    expect(returnAfterKeep).toBeLessThan(closeBrokerIdx)
  })

  it('still preserves the iOS remote headless bridge path', () => {
    const handler = windowAllClosedHandler()
    expect(handler).toContain('iosRemoteEnabled')
    expect(handler).toContain('resolveDaemonShouldRun')
    expect(handler).toContain('[remote-bridge] window closed')
  })

  it('only quits non-darwin when there is no keep-alive reason', () => {
    const handler = windowAllClosedHandler()
    const keepBranchEnd = handler.indexOf('return', handler.indexOf('keepActiveRunsAlive'))
    const quitIdx = handler.indexOf("process.platform !== 'darwin'")
    expect(quitIdx).toBeGreaterThan(keepBranchEnd)
    expect(handler.slice(quitIdx)).toContain('app.quit()')
  })

  it('keeps the RunManager lifecycle inventory exact across all ten provider identities', () => {
    // This is a lifecycle/cleanup invariant only. It does not make retired
    // Gemini selectable or bypass AntiGravity's consent and credential wall.
    expect(RUN_MANAGER_PROVIDERS).toEqual(ALL_PROVIDER_IDENTITIES)
    expect(new Set(RUN_MANAGER_PROVIDERS).size).toBe(ALL_PROVIDER_IDENTITIES.length)
  })

  it('tracks every live provider, including opted-in AntiGravity, in the run owner inventory', () => {
    expect(RUN_MANAGER_PROVIDERS).toEqual(expect.arrayContaining([...HEADLESS_LIVE_PROVIDERS]))
    expect(LIVE_SELECTABLE_PROVIDER_IDS).not.toContain('gemini')
    expect(LIVE_SELECTABLE_PROVIDER_IDS).not.toContain('antigravity')

    const manager = new RunManager()
    const sessions = HEADLESS_LIVE_PROVIDERS.map((provider, index) =>
      manager.create({
        runId: `headless-${provider}-${index}`,
        provider,
        appChatId: `headless-chat-${provider}`,
        status: 'running'
      })
    )

    for (const [index, provider] of HEADLESS_LIVE_PROVIDERS.entries()) {
      expect(manager.getActiveByProvider(provider)).toEqual([sessions[index]])
      expect(isActiveRunSessionStatus(sessions[index].status)).toBe(true)
    }

    for (const session of sessions) manager.finish(session.runId, 'completed')
    expect(
      HEADLESS_LIVE_PROVIDERS.flatMap((provider) => manager.getActiveByProvider(provider))
    ).toEqual([])
  })

  it('uses the same provider inventory for active-count and streaming checks', () => {
    const activeCount = sourceBetween(
      'function getActiveTaskWraithThreadCount(): number {',
      'function hasActiveStreamingTaskWraithRun(): boolean {'
    )
    expect(activeCount).toContain('for (const provider of RUN_MANAGER_PROVIDERS)')

    const streamingCheck = sourceBetween(
      'function hasActiveStreamingTaskWraithRun(): boolean {',
      'const appShellStatsService = new AppShellStatsService'
    )
    expect(streamingCheck).toContain('RUN_MANAGER_PROVIDERS.flatMap')
    expect(streamingCheck).toContain('hasStreamingRemoteRunSessions')
  })

  it('does not cancel provider runs or approvals when the renderer closes or crashes', () => {
    const browserWindowLifecycle = sourceBetween(
      "app.on('browser-window-created', (_, window) => {",
      '    // Phase E3: Bridge Networking'
    )

    expect(browserWindowLifecycle).toContain("window.once('closed'")
    expect(browserWindowLifecycle).toContain("window.webContents.on('render-process-gone'")
    expect(browserWindowLifecycle).toContain('chatUpdateDeliveryCoordinator.clearTarget')
    expect(browserWindowLifecycle).toContain('rendererResponsivenessTracker.clear')
    expect(browserWindowLifecycle).not.toContain('runManager.cancel(')
    expect(browserWindowLifecycle).not.toContain('runManager.finish(')
    expect(browserWindowLifecycle).not.toContain('approvalService?.cancelForRun')
    expect(browserWindowLifecycle).not.toContain('approvalService?.cancelAll')
    expect(browserWindowLifecycle).not.toContain('.kill(')
    expect(browserWindowLifecycle).not.toContain('app.quit()')

    const handler = windowAllClosedHandler()
    expect(handler).not.toContain('runManager.cancel(')
    expect(handler).not.toContain('approvalService?.cancelForRun')
    expect(handler).not.toContain('approvalService?.cancelAll')
  })

  it('keeps renderer delivery best-effort and makes durable headless sends no-op', () => {
    const headlessSender = sourceBetween(
      'function createHeadlessRunSender(): Electron.WebContents {',
      'function safeSendToWebContents('
    )
    expect(headlessSender).toContain('send: () => {}')
    expect(headlessSender).toContain('isDestroyed: () => false')
    expect(headlessSender).toContain('id: -1')

    const lifecycle = sourceBetween(
      "app.on('browser-window-created', (_, window) => {",
      '    // Phase E3: Bridge Networking'
    )
    expect(lifecycle).toContain("details.reason === 'clean-exit'")
    expect(lifecycle).toContain('recordProductCrash')
    expect(lifecycle).not.toContain('runManager.finish(')
  })

  it('reserves destructive process teardown for will-quit', () => {
    const willQuit = sourceBetween(
      "app.on('will-quit', () => {",
      '    // A crash after durable history prepare'
    )
    expect(willQuit).toContain('stopBridgeDaemon()')
    expect(willQuit).toContain('iosRemoteRuntime?.dispose()')
    expect(willQuit).toContain('workflowBudgetRegistry.disposeAll()')
    expect(willQuit).not.toContain('window-all-closed')
  })
})
