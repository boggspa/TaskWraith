import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import {
  clearRendererUsageRecordsCache,
  loadRendererUsageRecords,
  setCachedRendererUsageRecords
} from './usageRecordsCache'

const usageRecord = (id: string): UsageRecord =>
  ({
    id,
    provider: 'codex',
    timestamp: Date.now(),
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    runId: 'run-1',
    usageKind: 'run',
    model: 'gpt-5-codex',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 0
  }) as UsageRecord

describe('usageRecordsCache', () => {
  afterEach(() => {
    clearRendererUsageRecordsCache()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('dedupes concurrent external usage loads', async () => {
    vi.useFakeTimers()
    const records = [usageRecord('external-1')]
    const getExternalUsage = vi.fn(
      () => new Promise<UsageRecord[]>((resolve) => window.setTimeout(() => resolve(records), 20))
    )
    vi.stubGlobal('window', {
      api: {
        getExternalUsage,
        getUsage: vi.fn()
      },
      setTimeout,
      clearTimeout
    })

    const first = loadRendererUsageRecords('external')
    const second = loadRendererUsageRecords('external')
    await vi.advanceTimersByTimeAsync(20)

    await expect(first).resolves.toBe(records)
    await expect(second).resolves.toBe(records)
    expect(getExternalUsage).toHaveBeenCalledTimes(1)
  })

  it('serves fresh cached records without calling IPC', async () => {
    const records = [usageRecord('cached-1')]
    setCachedRendererUsageRecords('external', records, Date.now())
    const getExternalUsage = vi.fn()
    vi.stubGlobal('window', {
      api: {
        getExternalUsage,
        getUsage: vi.fn()
      }
    })

    await expect(loadRendererUsageRecords('external', { maxAgeMs: 60_000 })).resolves.toBe(records)
    expect(getExternalUsage).not.toHaveBeenCalled()
  })

  it('forwards force to the external IPC so manual refresh bypasses the main cache', async () => {
    const fresh = [usageRecord('forced-1')]
    setCachedRendererUsageRecords('external', [usageRecord('stale-1')], Date.now())
    const getExternalUsage = vi.fn(() => Promise.resolve(fresh))
    vi.stubGlobal('window', {
      api: {
        getExternalUsage,
        getUsage: vi.fn()
      }
    })

    await expect(loadRendererUsageRecords('external', { force: true })).resolves.toBe(fresh)
    expect(getExternalUsage).toHaveBeenCalledWith({ force: true })
  })

  it('does not pass force to the external IPC on ordinary loads', async () => {
    const records = [usageRecord('plain-1')]
    const getExternalUsage = vi.fn(() => Promise.resolve(records))
    vi.stubGlobal('window', {
      api: {
        getExternalUsage,
        getUsage: vi.fn()
      }
    })

    await expect(loadRendererUsageRecords('external')).resolves.toBe(records)
    expect(getExternalUsage).toHaveBeenCalledWith(undefined)
  })
})
