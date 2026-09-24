import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeMistralPlanId } from '../mistral/MistralCliArgs'
import {
  mistralAdminKeyStore,
  type MistralAdminKeyStatus,
  type MistralAdminKeyStore
} from '../mistral/MistralAdminKeyStore'
import {
  convertVendorAmountToUsd,
  fetchMistralAdminUsage,
  meterSpendFrom
} from '../mistral/MistralAdminUsage'
import {
  clearMistralQuotaAnchor,
  currentMistralQuotaEstimate,
  setMistralPlan,
  setMistralQuotaAnchor,
  setMistralQuotaReport,
  type MistralQuotaSnapshot
} from '../mistral/MistralQuotaStore'
import {
  MISTRAL_ADMIN_KEY_CLEAR_CHANNEL,
  MISTRAL_ADMIN_KEY_SET_CHANNEL,
  MISTRAL_ADMIN_KEY_STATUS_CHANNEL,
  MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL,
  MISTRAL_QUOTA_GET_CHANNEL,
  MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL,
  MISTRAL_QUOTA_SET_ANCHOR_CHANNEL,
  MISTRAL_QUOTA_SET_PLAN_CHANNEL,
  registerMistralQuotaHandlers,
  unregisterMistralQuotaHandlers
} from './mistralQuotaHandlers'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

vi.mock('../mistral/MistralCliArgs', () => ({
  normalizeMistralPlanId: vi.fn(() => 'pro')
}))

vi.mock('../mistral/MistralQuotaStore', () => ({
  currentMistralQuotaEstimate: vi.fn(),
  setMistralPlan: vi.fn(),
  setMistralQuotaAnchor: vi.fn(),
  clearMistralQuotaAnchor: vi.fn(),
  setMistralQuotaReport: vi.fn()
}))

vi.mock('../mistral/MistralAdminKeyStore', () => ({
  mistralAdminKeyStore: vi.fn()
}))

vi.mock('../mistral/MistralAdminUsage', () => ({
  convertVendorAmountToUsd: vi.fn(),
  fetchMistralAdminUsage: vi.fn(),
  meterSpendFrom: vi.fn()
}))

const ALL_CHANNELS = [
  MISTRAL_QUOTA_GET_CHANNEL,
  MISTRAL_QUOTA_SET_PLAN_CHANNEL,
  MISTRAL_QUOTA_SET_ANCHOR_CHANNEL,
  MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL,
  MISTRAL_ADMIN_KEY_STATUS_CHANNEL,
  MISTRAL_ADMIN_KEY_SET_CHANNEL,
  MISTRAL_ADMIN_KEY_CLEAR_CHANNEL,
  MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL
]

const snapshot: MistralQuotaSnapshot = {
  estimate: {
    band: 'quiet',
    usedPercent: 12,
    spentUsd: 1.5,
    locallyEstimatedSinceReadingUsd: 0,
    estimatedCeilingUsd: 10,
    confidence: 'seeded',
    ceilingConfidence: 'seeded',
    spentSource: { confidence: 'seeded' },
    ceilingSource: { confidence: 'seeded' },
    vendorReported: false,
    label: 'low',
    cycleResetsAt: '2026-10-01T00:00:00.000Z'
  },
  plan: 'pro',
  turns: 3,
  totalTokens: 1000
}

const keyStatus: MistralAdminKeyStatus = { configured: true, encryptionAvailable: true }

function createKeyStore() {
  return {
    getStatus: vi.fn(() => keyStatus),
    setApiKey: vi.fn((_input: string) => ({ ok: true, status: keyStatus })),
    clear: vi.fn(() => ({ ok: true, status: keyStatus })),
    loadApiKey: vi.fn(() => ({ status: 'ok', value: 'admin-key' }))
  } as unknown as MistralAdminKeyStore
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`missing handler for ${channel}`)
  return handler({}, ...args)
}

describe('mistralQuotaHandlers', () => {
  // () => unknown is assignable to the () => void dep, and lets the
  // fire-and-forget test return a never-settling promise.
  let requestWebUsageRefresh: ReturnType<typeof vi.fn<() => unknown>>

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    requestWebUsageRefresh = vi.fn((): unknown => undefined)
    vi.mocked(currentMistralQuotaEstimate).mockResolvedValue(snapshot)
    registerMistralQuotaHandlers({ requestWebUsageRefresh })
  })

  it('exposes the original eight channel names', () => {
    expect(ALL_CHANNELS).toEqual([
      'mistral-quota:get',
      'mistral-quota:set-plan',
      'mistral-quota:set-anchor',
      'mistral-quota:clear-anchor',
      'mistral-admin-key:status',
      'mistral-admin-key:set',
      'mistral-admin-key:clear',
      'mistral-quota:refresh-admin'
    ])
  })

  it('registers all eight handlers', () => {
    for (const channel of ALL_CHANNELS) expect(handlers.has(channel)).toBe(true)
  })

  it('get fires the web refresh and returns the current estimate', async () => {
    await expect(invoke(MISTRAL_QUOTA_GET_CHANNEL)).resolves.toBe(snapshot)
    expect(requestWebUsageRefresh).toHaveBeenCalledTimes(1)
    expect(requestWebUsageRefresh).toHaveBeenCalledWith()
  })

  it('get returns null until the seat has run, refresh still fired', async () => {
    vi.mocked(currentMistralQuotaEstimate).mockResolvedValue(null)
    await expect(invoke(MISTRAL_QUOTA_GET_CHANNEL)).resolves.toBeNull()
    expect(requestWebUsageRefresh).toHaveBeenCalledTimes(1)
  })

  it('get never awaits the web refresh', async () => {
    requestWebUsageRefresh.mockReturnValueOnce(new Promise(() => {}))
    await expect(invoke(MISTRAL_QUOTA_GET_CHANNEL)).resolves.toBe(snapshot)
  })

  it('set-plan normalizes, persists, and returns the estimate', async () => {
    await expect(invoke(MISTRAL_QUOTA_SET_PLAN_CHANNEL, '  TEAM ')).resolves.toBe(snapshot)
    expect(vi.mocked(normalizeMistralPlanId)).toHaveBeenCalledWith('  TEAM ')
    expect(vi.mocked(setMistralPlan)).toHaveBeenCalledWith('pro')
  })

  it('set-anchor rejects a zero allowance without persisting', async () => {
    await expect(
      invoke(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL, { allowanceUsd: 0, spentUsd: 1 })
    ).resolves.toBe(snapshot)
    expect(vi.mocked(setMistralQuotaAnchor)).not.toHaveBeenCalled()
  })

  it('set-anchor rejects a negative spend without persisting', async () => {
    await expect(
      invoke(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL, { allowanceUsd: 10, spentUsd: -1 })
    ).resolves.toBe(snapshot)
    expect(vi.mocked(setMistralQuotaAnchor)).not.toHaveBeenCalled()
  })

  it('set-anchor rejects a non-finite allowance without persisting', async () => {
    await expect(
      invoke(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL, { allowanceUsd: 'lots', spentUsd: 1 })
    ).resolves.toBe(snapshot)
    expect(vi.mocked(setMistralQuotaAnchor)).not.toHaveBeenCalled()
  })

  it('set-anchor persists a full reading with declared block and cycle passthrough', async () => {
    await expect(
      invoke(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL, {
        allowanceUsd: 10,
        spentUsd: 3,
        cycleResetsAt: '2026-09-01T00:00:00.000Z',
        declared: { allowance: 100, spent: 30, currency: 'eur' }
      })
    ).resolves.toBe(snapshot)
    expect(vi.mocked(setMistralQuotaAnchor)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(setMistralQuotaAnchor)).toHaveBeenCalledWith({
      allowanceUsd: 10,
      spentUsd: 3,
      cycleResetsAt: '2026-09-01T00:00:00.000Z',
      declared: { allowance: 100, spent: 30, currency: 'EUR' }
    })
  })

  it('set-anchor drops an invalid cycle and an incomplete declared block', async () => {
    await expect(
      invoke(MISTRAL_QUOTA_SET_ANCHOR_CHANNEL, {
        allowanceUsd: 10,
        spentUsd: 3,
        cycleResetsAt: 'not-a-date',
        declared: { allowance: 100, spent: 30 }
      })
    ).resolves.toBe(snapshot)
    expect(vi.mocked(setMistralQuotaAnchor)).toHaveBeenCalledWith({
      allowanceUsd: 10,
      spentUsd: 3
    })
  })

  it('clear-anchor clears and returns the estimate', async () => {
    await expect(invoke(MISTRAL_QUOTA_CLEAR_ANCHOR_CHANNEL)).resolves.toBe(snapshot)
    expect(vi.mocked(clearMistralQuotaAnchor)).toHaveBeenCalledTimes(1)
  })

  it('admin status returns null when the store is unavailable', async () => {
    vi.mocked(mistralAdminKeyStore).mockReturnValue(null)
    await expect(invoke(MISTRAL_ADMIN_KEY_STATUS_CHANNEL)).resolves.toBeNull()
  })

  it('admin status projects the store status', async () => {
    vi.mocked(mistralAdminKeyStore).mockReturnValue(createKeyStore())
    await expect(invoke(MISTRAL_ADMIN_KEY_STATUS_CHANNEL)).resolves.toBe(keyStatus)
  })

  it('admin set reports unavailable without a store', async () => {
    vi.mocked(mistralAdminKeyStore).mockReturnValue(null)
    await expect(invoke(MISTRAL_ADMIN_KEY_SET_CHANNEL, 'k')).resolves.toEqual({
      ok: false,
      error: 'unavailable'
    })
  })

  it('admin set persists the String-coerced key and omits the error key on success', async () => {
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    await expect(invoke(MISTRAL_ADMIN_KEY_SET_CHANNEL, 'k')).resolves.toEqual({ ok: true })
    expect(store.setApiKey).toHaveBeenCalledWith('k')
  })

  it('admin set surfaces a store error', async () => {
    const store = createKeyStore()
    vi.mocked(store.setApiKey).mockReturnValue({
      ok: false,
      status: keyStatus,
      error: 'writeFailed'
    })
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    await expect(invoke(MISTRAL_ADMIN_KEY_SET_CHANNEL, 'k')).resolves.toEqual({
      ok: false,
      error: 'writeFailed'
    })
  })

  it('admin clear reports unavailable without a store and clears with one', async () => {
    vi.mocked(mistralAdminKeyStore).mockReturnValue(null)
    await expect(invoke(MISTRAL_ADMIN_KEY_CLEAR_CHANNEL)).resolves.toEqual({
      ok: false,
      error: 'unavailable'
    })
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    await expect(invoke(MISTRAL_ADMIN_KEY_CLEAR_CHANNEL)).resolves.toEqual({ ok: true })
    expect(store.clear).toHaveBeenCalledTimes(1)
  })

  it('refresh-admin reports unavailable without a store', async () => {
    vi.mocked(mistralAdminKeyStore).mockReturnValue(null)
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: false,
      failure: 'unavailable'
    })
  })

  it('refresh-admin maps a missing key to no-key and passes other load states through', async () => {
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    vi.mocked(store.loadApiKey).mockReturnValue({ status: 'missing' })
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: false,
      failure: 'no-key'
    })
    vi.mocked(store.loadApiKey).mockReturnValue({ status: 'corrupt' })
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: false,
      failure: 'corrupt'
    })
    expect(vi.mocked(fetchMistralAdminUsage)).not.toHaveBeenCalled()
  })

  it('refresh-admin passes a fetch failure through without persisting', async () => {
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    vi.mocked(fetchMistralAdminUsage).mockResolvedValue({ ok: false, failure: 'unauthorized' })
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: false,
      failure: 'unauthorized'
    })
    expect(vi.mocked(fetchMistralAdminUsage)).toHaveBeenCalledWith({ apiKey: 'admin-key' })
    expect(vi.mocked(setMistralQuotaReport)).not.toHaveBeenCalled()
  })

  it('refresh-admin folds the converted report and returns the snapshot', async () => {
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    const usage = {
      totalSpend: 5,
      currency: 'EUR',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z',
      byCategory: {}
    }
    vi.mocked(fetchMistralAdminUsage).mockResolvedValue({ ok: true, usage })
    vi.mocked(meterSpendFrom).mockReturnValue(5)
    vi.mocked(convertVendorAmountToUsd).mockReturnValue(5.5)
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: true,
      snapshot
    })
    expect(vi.mocked(meterSpendFrom)).toHaveBeenCalledWith(usage)
    expect(vi.mocked(convertVendorAmountToUsd)).toHaveBeenCalledWith(5, 'EUR')
    expect(vi.mocked(setMistralQuotaReport)).toHaveBeenCalledWith({
      spentUsd: 5.5,
      fetchedAt: expect.any(String),
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z',
      declared: { spent: 5, currency: 'EUR' }
    })
  })

  it('refresh-admin omits period and declared fields the vendor did not report', async () => {
    const store = createKeyStore()
    vi.mocked(mistralAdminKeyStore).mockReturnValue(store)
    const usage = { totalSpend: 5, byCategory: {} }
    vi.mocked(fetchMistralAdminUsage).mockResolvedValue({ ok: true, usage })
    vi.mocked(meterSpendFrom).mockReturnValue(5)
    vi.mocked(convertVendorAmountToUsd).mockReturnValue(5)
    await expect(invoke(MISTRAL_QUOTA_REFRESH_ADMIN_CHANNEL)).resolves.toEqual({
      ok: true,
      snapshot
    })
    expect(vi.mocked(setMistralQuotaReport)).toHaveBeenCalledWith({
      spentUsd: 5,
      fetchedAt: expect.any(String)
    })
  })

  it('unregister removes all eight handlers', () => {
    expect(handlers.size).toBe(8)
    unregisterMistralQuotaHandlers()
    expect(handlers.size).toBe(0)
  })
})
