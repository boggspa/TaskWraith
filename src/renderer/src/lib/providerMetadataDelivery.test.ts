import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../../../main/mainSourceProbe.testutil'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import {
  providerMetadataBootRefreshes,
  providerMetadataWarmupQueue,
  providersTabMetadataRefreshes
} from './providerMetadataDelivery'

describe('providerMetadataWarmupQueue', () => {
  it('keeps the active provider, Pi and Ollama out of the idle queue and nothing else', () => {
    const queue = providerMetadataWarmupQueue('codex')
    expect(queue).not.toContain('codex')
    expect(queue).not.toContain('pi')
    expect(queue).not.toContain('ollama')
    expect(queue).toEqual(
      LIVE_SELECTABLE_PROVIDER_IDS.filter(
        (provider) => provider !== 'codex' && provider !== 'pi' && provider !== 'ollama'
      )
    )
    expect(queue.length).toBeGreaterThan(0)
  })

  it('does not exempt a provider merely because it is active', () => {
    expect(providerMetadataWarmupQueue('ollama')).toContain('codex')
  })
})

describe('providerMetadataBootRefreshes', () => {
  it('asks for Ollama once at boot unless it was the active provider already refreshed', () => {
    expect(providerMetadataBootRefreshes('codex')).toEqual(['ollama'])
    expect(providerMetadataBootRefreshes('ollama')).toEqual([])
  })
})

describe('providersTabMetadataRefreshes', () => {
  it('probes Ollama only while the Providers tab is showing', () => {
    expect(
      providersTabMetadataRefreshes({ showSettings: true, settingsActiveTab: 'providers' })
    ).toEqual(['ollama'])
    expect(
      providersTabMetadataRefreshes({ showSettings: false, settingsActiveTab: 'providers' })
    ).toEqual([])
    expect(
      providersTabMetadataRefreshes({ showSettings: true, settingsActiveTab: 'appearance' })
    ).toEqual([])
  })
})

// Renderer suites have no jsdom, so the App wiring is pinned structurally:
// each locator throws when its subject is renamed or deleted, never passing
// over nothing.
describe('App wiring', () => {
  const probe = new MainSourceProbe('App.tsx', new URL('../App.tsx', import.meta.url))
  const app = probe.fn('App')

  function enclosing<T extends ts.Node>(
    node: ts.Node,
    match: (candidate: ts.Node) => candidate is T
  ): T {
    let current: ts.Node | undefined = node
    while (current && !match(current)) current = current.parent
    if (!current) throw new Error(`no enclosing node for ${probe.text(node)}`)
    return current
  }

  it('feeds the idle warmup queue from providerMetadataWarmupQueue', () => {
    const calls = probe.callsTo(app, 'scheduleProviderMetadataWarmup')
    expect(calls).toHaveLength(1)
    expect(probe.propText(calls[0], 0, 'providers')).toBe(
      'providerMetadataWarmupQueue(activeProvider)'
    )
  })

  it('refreshes the boot providers directly after arming the queue', () => {
    const calls = probe.callsTo(app, 'providerMetadataBootRefreshes')
    expect(calls).toHaveLength(1)
    const loop = enclosing(calls[0], ts.isForOfStatement)
    expect(probe.text(loop.statement).replace(/\s+/g, ' ')).toContain(
      'refreshProviderMetadata(provider)'
    )
  })

  it('probes Ollama when the Providers tab opens, keyed on the tab state alone', () => {
    const calls = probe.callsTo(app, 'providersTabMetadataRefreshes')
    expect(calls).toHaveLength(1)
    const effect = enclosing(
      calls[0],
      (candidate): candidate is ts.CallExpression =>
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === 'useEffect'
    )
    expect(probe.argText(effect, 0)).toContain('refreshProviderMetadataRef.current')
    expect(probe.argText(effect, 1)).toBe('[showSettings, settingsActiveTab]')
  })
})
