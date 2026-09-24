import { describe, expect, it, vi } from 'vitest'
import { ProviderContextDiagnostics } from './ProviderContextDiagnostics'

describe('provider context policy receipts', () => {
  it('records the config actually sent even when the returned model differs from the request', () => {
    const emit = vi.fn()
    const diagnostics = new ProviderContextDiagnostics(emit)
    diagnostics.configureCodex({ appRunId: 'fallback-model' }, 'gpt-6-astra', '0.153.0', {})
    expect(emit.mock.lastCall?.[1].requestedWindowTokens).toBeUndefined()
    expect(emit.mock.lastCall?.[1].requestedCompactionTokens).toBeUndefined()
    expect(emit.mock.lastCall?.[1].configurationSource).toBe('provider-default')
  })
  it('does not recreate run history when persistence authority has closed', () => {
    const emit = vi.fn()
    let authorized = true
    const diagnostics = new ProviderContextDiagnostics(emit, () => authorized)
    const owner = { appRunId: 'deleted-run' }
    diagnostics.configureCodex(owner, 'gpt-6-astra')
    authorized = false
    diagnostics.observeCodex(owner, { modelContextWindow: 828_400 })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('waits for the actual model identity before assigning capacity to Claude default', () => {
    const emit = vi.fn()
    const owner = { appRunId: 'default-claude' }
    const diagnostics = new ProviderContextDiagnostics(emit)
    diagnostics.configureClaude(owner, 'default')
    expect(emit.mock.lastCall?.[1].modelCapacityTokens).toBeUndefined()
    diagnostics.observeClaude(owner, {
      type: 'system',
      subtype: 'init',
      model: 'claude-fable-5-1',
      claude_code_version: '2.1.261'
    })
    expect(emit.mock.lastCall?.[1].modelCapacityTokens).toBe(1_000_000)
  })
  it('retains requested Astra limits alongside the smaller runtime window', () => {
    const emit = vi.fn()
    const diagnostics = new ProviderContextDiagnostics(emit)
    const owner = { appRunId: 'astra-run' }
    diagnostics.configureCodex(owner, 'gpt-6-astra', 'codex-cli 0.153.0')
    diagnostics.observeCodex(owner, { modelContextWindow: 258_400 })
    diagnostics.observeCodex(owner, { modelContextWindow: 258_400, last: { totalTokens: 467717 } })
    expect(emit).toHaveBeenCalledTimes(2)
    const signal = diagnostics.enrich(owner, {
      kind: 'completed',
      telemetry: { preTokens: 467717 }
    })
    expect(signal.telemetry.contextPolicy).toMatchObject({
      modelCapacityTokens: 1_050_000,
      requestedWindowTokens: 1_050_000,
      requestedCompactionTokens: 850_000,
      reportedWindowTokens: 258_400,
      runtimeVersion: '0.153.0'
    })
    expect(signal.telemetry.contextPolicy?.reportedCompactionTokens).toBeUndefined()
  })

  it('isolates concurrent seats and freezes past compaction evidence', () => {
    const diagnostics = new ProviderContextDiagnostics(vi.fn())
    const first = { appRunId: 'first' },
      second = { appRunId: 'second' }
    diagnostics.configureCodex(first, 'gpt-6-astra')
    diagnostics.configureCodex(second, 'gpt-5.4-mini')
    diagnostics.observeCodex(first, { modelContextWindow: 258_400 })
    const old = diagnostics.enrich(first, { kind: 'completed', telemetry: {} })
    diagnostics.observeCodex(first, { modelContextWindow: 828_400 })
    expect(old.telemetry.contextPolicy?.reportedWindowTokens).toBe(258_400)
    expect(
      diagnostics.enrich(second, { kind: 'completed', telemetry: {} }).telemetry.contextPolicy
    ).toMatchObject({ model: 'gpt-5.4-mini', configurationSource: 'provider-default' })
    expect(
      diagnostics.enrich(second, { kind: 'completed', telemetry: {} }).telemetry.contextPolicy
        ?.reportedWindowTokens
    ).toBeUndefined()
  })

  it('records Claude native version and selected-model limits without assuming a 1M working window', () => {
    const emit = vi.fn(),
      owner = { appRunId: 'claude-run' }
    const diagnostics = new ProviderContextDiagnostics(emit)
    diagnostics.configureClaude(owner, 'claude-fable-5-1', {
      source: 'user-settings',
      windowTokens: 650_000
    })
    diagnostics.observeClaude(owner, {
      type: 'system',
      subtype: 'init',
      model: 'claude-fable-5-1',
      claude_code_version: '2.1.251'
    })
    expect(
      diagnostics.enrich(owner, { kind: 'started', telemetry: {} }).telemetry.contextPolicy
        ?.reportedWindowTokens
    ).toBeUndefined()
    diagnostics.observeClaude(owner, {
      type: 'result',
      modelUsage: {
        'claude-fable-5-1': { contextWindow: 200_000 },
        'claude-sonnet-5': { contextWindow: 1_000_000 }
      }
    })
    expect(emit.mock.lastCall?.[1]).toMatchObject({
      runtimeVersion: '2.1.251',
      requestedCompactionTokens: 650_000,
      reportedWindowTokens: 200_000,
      configurationSource: 'user-settings'
    })
  })

  it('ignores malformed measurements, keeps unknown capacity unknown, and tolerates a failed sink', () => {
    const diagnostics = new ProviderContextDiagnostics(() => {
      throw new Error('disk unavailable')
    })
    const owner = { appRunId: 'future' }
    diagnostics.configureCodex(owner, 'private-future-model')
    for (const modelContextWindow of [null, -1, 0, NaN, '1000000'])
      diagnostics.observeCodex(owner, { modelContextWindow })
    expect(
      diagnostics.enrich(owner, { kind: 'completed', telemetry: {} }).telemetry.contextPolicy
    ).toMatchObject({ model: 'private-future-model', configurationSource: 'provider-default' })
    expect(
      diagnostics.enrich(owner, { kind: 'completed', telemetry: {} }).telemetry.contextPolicy
        ?.modelCapacityTokens
    ).toBeUndefined()
    const legacy = { kind: 'completed' as const, telemetry: { preTokens: 5 } }
    expect(diagnostics.enrich({}, legacy)).toBe(legacy)
  })
})
