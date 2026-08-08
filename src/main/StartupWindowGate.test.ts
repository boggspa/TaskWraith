import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { StartupWindowGate } from './StartupWindowGate'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('StartupWindowGate', () => {
  it('defers a startup-time second-instance window request until IPC is ready', () => {
    const gate = new StartupWindowGate()
    const createWindow = vi.fn()

    expect(gate.requestWindow(createWindow)).toBe(false)
    expect(createWindow).not.toHaveBeenCalled()

    expect(gate.release(createWindow)).toBe(true)
    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('opens immediately after startup and only flushes a deferred request once', () => {
    const gate = new StartupWindowGate()
    const createWindow = vi.fn()

    expect(gate.release(createWindow)).toBe(false)
    expect(gate.release(createWindow)).toBe(false)
    expect(gate.requestWindow(createWindow)).toBe(true)
    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('keeps the second-instance path behind run IPC registration', () => {
    const deferredOpen = indexSource.indexOf('startupWindowGate.requestWindow(createWindow)')
    const runAgentHandler = indexSource.indexOf("ipcMain.handle('run-agent'")
    const ensembleHandler = indexSource.indexOf("'run-ensemble-round'")
    const gateRelease = indexSource.indexOf('startupWindowGate.release(createWindow)')

    expect(deferredOpen).toBeGreaterThanOrEqual(0)
    expect(runAgentHandler).toBeGreaterThan(deferredOpen)
    expect(ensembleHandler).toBeGreaterThan(runAgentHandler)
    expect(gateRelease).toBeGreaterThan(ensembleHandler)
  })
})
