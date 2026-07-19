import { describe, expect, it } from 'vitest'
import {
  createProviderAdapterRegistry,
  defaultProviderDescriptor,
  providerAdapterDescriptor,
  providerLabel
} from './ProviderAdapters'
import type { ProviderAdapter } from './ProviderAdapters'
import type { ProviderId } from './store/types'

function adapter(provider: 'gemini' | 'codex'): ProviderAdapter {
  return {
    ...defaultProviderDescriptor(provider),
    run: async () => {},
    cancel: async () => true,
    getStatus: async () => ({ provider }),
    getMcpStatus: async () => null,
    getCapabilityContract: async () => ({
      provider,
      label: providerLabel(provider),
      refreshedAt: '2026-05-07T00:00:00.000Z',
      availability: { available: true },
      tools: {} as never,
      approvals: {
        requestedMode: 'default',
        effectiveMode: 'default',
        providerMode: 'default',
        inAppApprovals: false,
        supportsWorkspaceGrants: false,
        notes: []
      },
      mcp: { state: 'unavailable', source: 'unsupported', available: false, tools: [] },
      warnings: []
    })
  }
}

describe('ProviderAdapters', () => {
  it('provides stable labels and descriptors for every provider boundary', () => {
    // 1.0.4-AC — `providerLabel` is the canonical title-building
    // helper used by the MCP approval-prompt builder (see
    // `McpToolApprovalPreview.ts`). The bug
    // pre-1.0.4-AC was that approval titles hardcoded "Gemini"
    // even when Codex / Claude / Kimi was the parent provider on a
    // cross-provider MCP call. Verifying the label is correct for
    // all four providers locks in the contract that fix relies on.
    expect(providerLabel('gemini')).toBe('Gemini')
    expect(providerLabel('codex')).toBe('Codex')
    expect(providerLabel('claude')).toBe('Claude')
    expect(providerLabel('kimi')).toBe('Kimi')
    expect(providerLabel('grok')).toBe('Grok')
    expect(providerLabel('cursor')).toBe('Cursor')
    expect(providerLabel('ollama')).toBe('Ollama')
    expect(defaultProviderDescriptor('codex')).toMatchObject({
      provider: 'codex',
      transport: 'codex-app-server',
      runChannel: 'run-agent',
      features: {
        appManagedApprovals: true,
        hostCommandFallback: true,
        nativeThreadTools: true
      }
    })
    expect(defaultProviderDescriptor('gemini')).toMatchObject({
      provider: 'gemini',
      runChannel: 'run-agent',
      features: {
        agentBenchMcpBridge: true,
        workspaceGrants: true
      }
    })
    expect(
      (['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'] as const).map(
        (provider) => defaultProviderDescriptor(provider).runChannel
      )
    ).toEqual([
      'run-agent',
      'run-agent',
      'run-agent',
      'run-agent',
      'run-agent',
      'run-agent',
      'run-agent'
    ])
  })

  it('enforces one adapter per provider and requires registered providers', () => {
    const registry = createProviderAdapterRegistry([adapter('gemini'), adapter('codex')])

    expect(registry.require('gemini').label).toBe('Gemini')
    expect(
      registry
        .descriptors()
        .map((descriptor) => descriptor.provider)
        .sort()
    ).toEqual(['codex', 'gemini'])
    expect(() => createProviderAdapterRegistry([adapter('gemini'), adapter('gemini')])).toThrow(
      /already registered/
    )
    expect(() => registry.require('claude')).toThrow(/not registered/)
  })

  it('returns serializable descriptors without runtime functions', () => {
    const descriptor = providerAdapterDescriptor(adapter('codex'))

    expect(descriptor).toEqual(defaultProviderDescriptor('codex'))
    expect('run' in descriptor).toBe(false)
    expect('cancel' in descriptor).toBe(false)
  })
})

describe('defaultProviderDescriptor capabilities', () => {
  // Per-provider capability declarations — these are the static "what
  // does this provider's UX support" flags that iOS composer + desktop
  // renderer consume to decide what to render. Pinning them as tests
  // means any change is reviewable; silently flipping (e.g. removing
  // image support from Gemini) requires touching this file.
  const allProviders: ProviderId[] = [
    'gemini',
    'codex',
    'claude',
    'kimi',
    'grok',
    'cursor',
    'ollama'
  ]

  for (const provider of allProviders) {
    it(`${provider} declares a non-empty approvalModes list`, () => {
      const cap = defaultProviderDescriptor(provider).capabilities
      if (provider === 'cursor') {
        expect(cap.approvalModes).toEqual([])
      } else if (provider === 'ollama') {
        expect(cap.approvalModes).toEqual(['plan'])
      } else {
        expect(cap.approvalModes.length).toBeGreaterThan(0)
        // Must always include 'default' — every CLI provider's runtime accepts
        // the baseline approval prompt mode.
        expect(cap.approvalModes).toContain('default')
      }
    })

    it(`${provider} declares boolean capability flags`, () => {
      const cap = defaultProviderDescriptor(provider).capabilities
      expect(typeof cap.reasoningEffort).toBe('boolean')
      expect(typeof cap.imageAttachments).toBe('boolean')
      expect(typeof cap.contextInjection).toBe('boolean')
      expect(typeof cap.sessionResumption).toBe('boolean')
      expect(typeof cap.perThreadMcp).toBe('boolean')
      expect(['token', 'turn', 'none']).toContain(cap.assistantTextStreaming)
    })

    it(`${provider} declares a serializable capabilities object`, () => {
      const cap = defaultProviderDescriptor(provider).capabilities
      expect(() => JSON.parse(JSON.stringify(cap))).not.toThrow()
    })
  }

  it('gemini supports plan mode + image attachments + per-thread MCP', () => {
    const cap = defaultProviderDescriptor('gemini').capabilities
    expect(cap.approvalModes).toContain('plan')
    expect(cap.imageAttachments).toBe(true)
    expect(cap.perThreadMcp).toBe(true)
  })

  it('codex supports reasoning effort, speed tiers, and image attachments', () => {
    const cap = defaultProviderDescriptor('codex').capabilities
    expect(cap.reasoningEffort).toBe(true)
    expect(cap.speedTiers.length).toBeGreaterThan(0)
    expect(cap.imageAttachments).toBe(true)
  })

  it('claude supports reasoning effort + fast mode', () => {
    const cap = defaultProviderDescriptor('claude').capabilities
    expect(cap.reasoningEffort).toBe(true)
    expect(cap.speedTiers).toEqual(['fast'])
  })

  it('kimi advertises governed default/plan modes and its HighSpeed tier', () => {
    const descriptor = defaultProviderDescriptor('kimi')
    const cap = descriptor.capabilities
    expect(cap.approvalModes).toEqual(['default', 'plan'])
    expect(cap.reasoningEffort).toBe(false)
    expect(cap.speedTiers).toEqual(['fast'])
    expect(cap.imageAttachments).toBe(false)
    expect(descriptor.transport).toBe('kimi-acp-authenticated-http-mcp')
    expect(descriptor.features.workspaceGrants).toBe(true)
    expect(descriptor.features.agentBenchMcpBridge).toBe(true)
    expect(descriptor.features.providerManagedMcp).toBe(false)
    expect(cap.perThreadMcp).toBe(true)
  })

  it('pins Cursor to unavailable with no approval or resume surface', () => {
    const descriptor = defaultProviderDescriptor('cursor')
    expect(descriptor.features.persistentSessions).toBe(false)
    expect(descriptor.features.agentBenchMcpBridge).toBe(false)
    expect(descriptor.capabilities.approvalModes).toEqual([])
    expect(descriptor.capabilities.sessionResumption).toBe(false)
    expect(descriptor.capabilityCaveats).toContainEqual(
      expect.objectContaining({
        id: 'cursor-tool-mode-unqualified',
        severity: 'warning',
        title: 'Cursor managed runs are temporarily unavailable'
      })
    )
  })

  it('pins Grok mode-scoped TaskWraith bridge caveat', () => {
    const descriptor = defaultProviderDescriptor('grok')
    expect(descriptor.features.agentBenchMcpBridge).toBe(false)
    expect(descriptor.capabilities.approvalModes).toEqual(['plan', 'default'])

    const caveat = descriptor.capabilityCaveats?.find(
      (entry) => entry.id === 'grok-taskwraith-bridge-write-mode-only'
    )
    expect(caveat).toMatchObject({
      severity: 'info',
      capability: 'taskwraithMcpBridge',
      title: 'TaskWraith MCP bridge is mode-scoped'
    })
    const projected = providerAdapterDescriptor(descriptor)
    expect(projected.capabilityCaveats).toEqual(descriptor.capabilityCaveats)
  })

  it('declares Ollama as token-streaming after HTTP chunk forwarding', () => {
    const cap = defaultProviderDescriptor('ollama').capabilities
    expect(cap.assistantTextStreaming).toBe('token')
  })
})
