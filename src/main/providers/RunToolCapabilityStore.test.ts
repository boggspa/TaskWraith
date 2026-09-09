import { describe, expect, it } from 'vitest'
import { createRunToolCapabilityReceipt } from './RunToolCapabilityReceipt'
import {
  createRunToolCapabilityCache,
  latestRunToolCapabilityReceipt,
  readRunToolCapabilityReceipt
} from './RunToolCapabilityStore'

function fixture(runId = 'run-1') {
  return createRunToolCapabilityReceipt({
    runId,
    chatId: 'chat-1',
    provider: 'cursor',
    model: 'model',
    transport: 'cursor-path-b',
    effectivePermissions: null,
    scope: { kind: 'global', workspacePath: null, paths: [] }
  })
}

describe('exact-run tool receipt storage', () => {
  it('bounds entries and age, clones outputs, and isolates run/chat/provider identity', () => {
    let now = 0
    const cache = createRunToolCapabilityCache({ now: () => now, maxAgeMs: 10, maxEntries: 1 })
    cache.put(fixture().snapshot())
    expect(cache.get('run-1', 'chat-other', 'cursor')).toBeNull()
    expect(cache.get('run-1', 'chat-1', 'pi')).toBeNull()
    const result = cache.get('run-1', 'chat-1', 'cursor')!
    result.model = 'corrupted'
    expect(cache.get('run-1', 'chat-1', 'cursor')!.model).toBe('model')
    cache.put(fixture('run-2').snapshot())
    expect(cache.get('run-1', 'chat-1', 'cursor')).toBeNull()
    now = 11
    expect(cache.get('run-2', 'chat-1', 'cursor')).toBeNull()
  })

  it('rejects stale revisions and cannot reopen a settled receipt', () => {
    const cache = createRunToolCapabilityCache()
    const r = fixture()
    const initial = r.snapshot()
    r.connection('ready')
    cache.put(r.snapshot())
    expect(cache.put(initial)).toBe(false)
    r.settle()
    cache.put(r.snapshot())
    expect(cache.put({ ...r.snapshot(), lifecycleSettled: false, revision: 999 })).toBe(false)
    expect(cache.get('run-1', 'chat-1', 'cursor')!.lifecycleSettled).toBe(true)
  })

  it('reads only matching main-origin lifecycle receipts, never provider-authored lookalikes', () => {
    const receipt = fixture().snapshot()
    const event = {
      source: 'main',
      kind: 'lifecycle',
      runId: 'run-1',
      chatId: 'chat-1',
      provider: 'cursor',
      payload: { toolCapabilityReceipt: receipt }
    }
    const identity = { runId: 'run-1', chatId: 'chat-1', provider: 'cursor' as const }
    expect(latestRunToolCapabilityReceipt(['partial', JSON.stringify(event)], identity)).toEqual(
      receipt
    )
    for (const override of [
      { source: 'provider' },
      { kind: 'tool' },
      { chatId: 'other' },
      { provider: 'pi' }
    ]) {
      expect(
        latestRunToolCapabilityReceipt([JSON.stringify({ ...event, ...override })], identity)
      ).toBeNull()
    }
  })
})

it.each([1, 3])(
  'merges a disk revision with live revision %s published during the read',
  async (liveRevision) => {
    const cache = createRunToolCapabilityCache()
    let finish!: (value: ReturnType<ReturnType<typeof fixture>['snapshot']>) => void
    const result = readRunToolCapabilityReceipt(
      { userDataPath: '/unused', runId: 'run-1', chatId: 'chat-1', provider: 'cursor' },
      {
        cache,
        readTail: () =>
          new Promise((resolve) => {
            finish = resolve
          })
      }
    )
    cache.put({ ...fixture().snapshot(), revision: liveRevision })
    finish({ ...fixture().snapshot(), revision: 2, readiness: 'degraded' })
    expect((await result)?.revision).toBe(Math.max(liveRevision, 2))
  }
)

it('does not substitute an old empty receipt for a truncated newest receipt', () => {
  const base = {
    source: 'main',
    kind: 'lifecycle',
    runId: 'run-1',
    chatId: 'chat-1',
    provider: 'cursor'
  }
  const lines = [
    JSON.stringify({ ...base, payload: { toolCapabilityReceipt: fixture().snapshot() } }),
    JSON.stringify({
      ...base,
      payload: { truncated: true, preview: 'provider_tool_capability_receipt' }
    })
  ]
  expect(
    latestRunToolCapabilityReceipt(lines, { runId: 'run-1', chatId: 'chat-1', provider: 'cursor' })
  ).toBeNull()
})
