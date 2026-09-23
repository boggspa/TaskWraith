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

  const isUseEffectCall = (candidate: ts.Node): candidate is ts.CallExpression =>
    ts.isCallExpression(candidate) &&
    ts.isIdentifier(candidate.expression) &&
    candidate.expression.text === 'useEffect'

  const compact = (node: ts.Node): string => probe.text(node).replace(/\s+/g, '')

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
    expect(probe.argText(calls[0], 0)).toBe('initialProvider')
    const loop = enclosing(calls[0], ts.isForOfStatement)
    expect(probe.text(loop.statement).replace(/\s+/g, ' ')).toContain(
      'refreshProviderMetadata(provider)'
    )
    // The statement right before the loop is the one that arms the queue for
    // the same provider.
    const block = loop.parent
    if (!ts.isBlock(block)) {
      throw new Error(`boot refresh loop is not in a block: ${compact(block)}`)
    }
    const armed = block.statements[block.statements.indexOf(loop) - 1]
    expect(armed && compact(armed).replace(/;$/, '')).toBe(
      'armProviderMetadataWarmup(initialProvider)'
    )
  })

  it('probes Ollama when the Providers tab opens, keyed on the tab state alone', () => {
    const calls = probe.callsTo(app, 'providersTabMetadataRefreshes')
    expect(calls).toHaveLength(1)
    const effect = enclosing(calls[0], isUseEffectCall)
    expect(probe.argText(effect, 0)).toContain('refreshProviderMetadataRef.current')
    expect(probe.argText(effect, 1)).toBe('[showSettings, settingsActiveTab]')
  })

  // The Providers-tab effect is keyed on the tab state alone, so it reads the
  // refresh through a ref. Unless that ref follows every render, the effect
  // calls the first render's refresh with its stale workspace and approval mode.
  it('keeps the Providers-tab refresh ref on the latest render', () => {
    expect(probe.text(probe.binding('refreshProviderMetadataRef'))).toBe(
      'useRef(refreshProviderMetadata)'
    )
    const assignments: ts.BinaryExpression[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        compact(node.left) === 'refreshProviderMetadataRef.current'
      ) {
        assignments.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(app)
    expect(assignments.map((assignment) => compact(assignment.right))).toEqual([
      'refreshProviderMetadata'
    ])
    // No dependency list: the effect runs after every render.
    expect(enclosing(assignments[0], isUseEffectCall).arguments).toHaveLength(1)
  })
})
