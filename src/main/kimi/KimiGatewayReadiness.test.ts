import { describe, expect, it, vi } from 'vitest'
import { createKimiGatewayReadiness, kimiGatewayCatalogueReady } from './KimiGatewayReadiness'

const initialized = { result: { protocolVersion: '2025-03-26' } }
const catalogue = (...names: string[]) => ({ result: { tools: names.map((name) => ({ name })) } })

describe('Kimi gateway readiness', () => {
  it('requires a successful initialization and nonempty served catalogue with required routes', () => {
    const state = createKimiGatewayReadiness()
    const generation = state.beginSession()
    state.responseServed(generation, 'initialize', { error: { code: -1 } })
    state.responseServed(generation, 'tools/list', catalogue('read_file'))
    expect(kimiGatewayCatalogueReady(state.snapshot())).toBe(false)
    state.responseServed(generation, 'initialize', initialized)
    expect(kimiGatewayCatalogueReady(state.snapshot(), [['replace', 'apply_patch']])).toBe(false)
    state.responseServed(generation, 'tools/list', catalogue('read_file', 'replace'))
    expect(kimiGatewayCatalogueReady(state.snapshot(), [['replace', 'apply_patch']])).toBe(true)
    expect(state.snapshot()).toMatchObject({ initializeResponses: 1, toolsListResponses: 2 })
  })

  it('never treats empty, malformed, or failed tool lists as ready', () => {
    const state = createKimiGatewayReadiness()
    state.responseServed(0, 'initialize', initialized)
    for (const response of [
      catalogue(),
      { result: { tools: [{ name: 'invalid name' }] } },
      { result: { tools: 'read_file' } },
      { error: { code: -1 }, result: { tools: [{ name: 'read_file' }] } }
    ]) {
      state.responseServed(0, 'tools/list', response)
      expect(kimiGatewayCatalogueReady(state.snapshot())).toBe(false)
    }
  })

  it('fences late responses and pending waits when the recovery session changes', async () => {
    const state = createKimiGatewayReadiness()
    const first = state.beginSession()
    const pending = state.waitForTools(1_000)
    const second = state.beginSession()
    await expect(pending).resolves.toBe(false)
    state.responseServed(first, 'initialize', initialized)
    state.responseServed(first, 'tools/list', catalogue('replace'))
    expect(kimiGatewayCatalogueReady(state.snapshot())).toBe(false)
    state.responseServed(second, 'initialize', initialized)
    state.responseServed(second, 'tools/list', catalogue('replace'))
    await expect(state.waitForTools(1_000, [['replace']])).resolves.toBe(true)
  })

  it('settles missing-tool waits on deadline or close and isolates diagnostic listeners', async () => {
    vi.useFakeTimers()
    try {
      const state = createKimiGatewayReadiness()
      state.subscribe(() => {
        throw new Error('observer failed')
      })
      const timed = state.waitForTools(100)
      await vi.advanceTimersByTimeAsync(100)
      await expect(timed).resolves.toBe(false)
      const pending = state.waitForTools(1_000)
      state.close()
      await expect(pending).resolves.toBe(false)
      await expect(state.waitForTools(1_000)).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
