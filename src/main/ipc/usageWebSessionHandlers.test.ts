import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerUsageWebSessionHandlers } from './usageWebSessionHandlers'

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  }
  const status = { configured: false, encryptionAvailable: true }
  const store = {
    getStatus: vi.fn(() => status),
    setSession: vi.fn(() => ({
      ok: true,
      status: { configured: true, encryptionAvailable: true, updatedAt: '2026-08-25T20:00:00Z' }
    })),
    clear: vi.fn(() => ({ ok: true, status }))
  }
  return { handlers, ipcMain, store }
}

const EVENT = {} as IpcMainInvokeEvent

describe('registerUsageWebSessionHandlers', () => {
  it('stores a validated import without returning the cookie to the renderer', async () => {
    const { handlers, ipcMain, store } = harness()
    registerUsageWebSessionHandlers({
      ipcMain,
      isMainRendererSender: () => true,
      store: () => store,
      importSession: async () => ({
        cookieHeader: 'session=secret',
        summary: { balance: 15, currency: 'GBP', capturedAt: '2026-08-25T20:00:00Z' }
      })
    })

    const result = await handlers.get('usage-web-session:import')?.(EVENT, 'meta')
    expect(store.setSession).toHaveBeenCalledWith({
      cookieHeader: 'session=secret',
      reading: { balance: 15, currency: 'GBP', capturedAt: '2026-08-25T20:00:00Z' }
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result).toMatchObject({ ok: true, status: { configured: true } })
  })

  it('rejects supplemental provider spoofing and secondary renderers', async () => {
    const { handlers, ipcMain, store } = harness()
    registerUsageWebSessionHandlers({
      ipcMain,
      isMainRendererSender: () => false,
      store: () => store
    })

    await expect(handlers.get('usage-web-session:get-status')?.(EVENT, 'muse')).resolves.toEqual({
      configured: false,
      encryptionAvailable: false
    })
    await expect(handlers.get('usage-web-session:import')?.(EVENT, 'meta')).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(store.setSession).not.toHaveBeenCalled()
  })

  it('clears only the selected provider store', async () => {
    const { handlers, ipcMain, store } = harness()
    const resolve = vi.fn(() => store)
    registerUsageWebSessionHandlers({
      ipcMain,
      isMainRendererSender: () => true,
      store: resolve
    })

    await handlers.get('usage-web-session:clear')?.(EVENT, 'qwen')
    expect(resolve).toHaveBeenCalledWith('qwen')
    expect(store.clear).toHaveBeenCalledOnce()
  })
})
