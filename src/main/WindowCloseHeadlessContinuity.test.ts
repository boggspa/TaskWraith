import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

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
})
