import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL,
  CODEX_USAGE_GET_SNAPSHOT_CHANNEL,
  CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL,
  registerCodexUsageHandlers,
  unregisterCodexUsageHandlers,
  type CodexUsageHandlerDeps
} from './codexUsageHandlers'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'

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

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function snapshotFixture(): NormalizedProviderUsageSnapshot {
  return { provider: 'codex', source: null, configured: true }
}

interface Harness {
  deps: CodexUsageHandlerDeps
  importer: Mock<CodexUsageHandlerDeps['importCodexUsageCredential']>
  clearer: Mock<CodexUsageHandlerDeps['clearCodexUsageCredential']>
  fetcher: Mock<CodexUsageHandlerDeps['fetchCodexUsageSnapshot']>
}

function harness(): Harness {
  const importer = vi.fn<CodexUsageHandlerDeps['importCodexUsageCredential']>(async () => ({
    imported: true
  }))
  const clearer = vi.fn<CodexUsageHandlerDeps['clearCodexUsageCredential']>(() => {})
  const fetcher = vi.fn<CodexUsageHandlerDeps['fetchCodexUsageSnapshot']>(async () =>
    snapshotFixture()
  )
  const deps: CodexUsageHandlerDeps = {
    importCodexUsageCredential: importer,
    clearCodexUsageCredential: clearer,
    fetchCodexUsageSnapshot: fetcher
  }
  registerCodexUsageHandlers(deps)
  return { deps, importer, clearer, fetcher }
}

describe('registerCodexUsageHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('registers exactly the three Codex usage channels', () => {
    harness()
    expect([...handlers.keys()].sort()).toEqual(
      [
        CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL,
        CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL,
        CODEX_USAGE_GET_SNAPSHOT_CHANNEL
      ].sort()
    )
  })

  it('passes the event and file path through to the importer and returns its result', async () => {
    const { importer } = harness()
    const result = { imported: true, accountId: 'acct-1', source: 'settings' }
    importer.mockResolvedValueOnce(result)
    const returned = await handlerFor(CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL)(
      EVENT,
      '/tmp/auth.json'
    )
    expect(importer).toHaveBeenCalledTimes(1)
    expect(importer).toHaveBeenCalledWith(EVENT, '/tmp/auth.json')
    expect(returned).toBe(result)
  })

  it('passes an omitted file path through as undefined without applying a default', async () => {
    const { importer } = harness()
    await handlerFor(CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL)(EVENT)
    expect(importer).toHaveBeenCalledTimes(1)
    expect(importer).toHaveBeenCalledWith(EVENT, undefined)
  })

  it('clears the credential and resolves true', async () => {
    const { clearer } = harness()
    const returned = await handlerFor(CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL)(EVENT)
    expect(clearer).toHaveBeenCalledTimes(1)
    expect(returned).toBe(true)
  })

  it('requests a forced snapshot only when force is exactly true', async () => {
    const { fetcher } = harness()
    await handlerFor(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)(EVENT, { force: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith({ force: true })
  })

  it('requests an unforced snapshot when options are omitted', async () => {
    const { fetcher } = harness()
    await handlerFor(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)(EVENT)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith({ force: false })
  })

  it('requests an unforced snapshot for truthy-but-not-true force values', async () => {
    const { fetcher } = harness()
    await handlerFor(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)(EVENT, { force: 'yes' })
    expect(fetcher).toHaveBeenCalledWith({ force: false })
    await handlerFor(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)(EVENT, { force: 1 })
    expect(fetcher).toHaveBeenCalledWith({ force: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('returns the fetched snapshot verbatim', async () => {
    const { fetcher } = harness()
    const snapshot = { ...snapshotFixture(), stale: true, fetchedAt: '2026-09-05T00:00:00.000Z' }
    fetcher.mockResolvedValueOnce(snapshot)
    const returned = await handlerFor(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)(EVENT, {})
    expect(returned).toBe(snapshot)
  })

  it('unregisters all three channels', () => {
    harness()
    expect(handlers.size).toBe(3)
    unregisterCodexUsageHandlers()
    expect(handlers.size).toBe(0)
    expect(handlers.has(CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL)).toBe(false)
    expect(handlers.has(CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL)).toBe(false)
    expect(handlers.has(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)).toBe(false)
  })
})
