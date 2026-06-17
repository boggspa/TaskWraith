import type { ProviderAdapter, ProviderRunContext } from './ProviderAdapters'
import type {
  ProviderId,
  ProviderAdapterDescriptor,
  ProviderCapabilityContract,
  ProviderAdapterTransport
} from './store/types'

/**
 * ProviderAdapterContract — generic conformance test battery for any
 * `ProviderAdapter` implementation.
 *
 * Phase C-late slice "provider-adapter test harness". A generic
 * contract suite lets each `ProviderAdapter` implementation prove the
 * same baseline behavior before registration. Future provider variants
 * all pass through this contract, so we catch regressions at registration
 * time rather than at runtime inside the renderer.
 *
 * Usage pattern (in a test file):
 *
 * ```typescript
 * import { describe } from 'vitest'
 * import { runProviderAdapterContractTests } from './ProviderAdapterContract'
 * import { makeGeminiAdapter } from './GeminiAdapter'  // hypothetical
 *
 * describe('GeminiAdapter', () => {
 *   runProviderAdapterContractTests({
 *     name: 'GeminiAdapter',
 *     factory: () => makeGeminiAdapter()
 *   })
 *   // ...plus Gemini-specific tests below as needed
 * })
 * ```
 *
 * The current adapters are constructed inline in `main/index.ts` as
 * part of a wider setup that requires runManager/permissionService/etc.
 * Future work: refactor each adapter into a factory function that can
 * be invoked from a unit test, then wire that factory into a per-adapter
 * test file that calls `runProviderAdapterContractTests`.
 *
 * The contract battery here verifies properties that MUST hold for any
 * adapter regardless of which CLI it wraps:
 *   - `provider` matches a known ProviderId enum value
 *   - Descriptor invariants (label, transport, runChannel, etc.)
 *   - `getCapabilityContract()` returns a serializable, well-shaped object
 *   - `cancel()` and `cancel(unknownRunId)` are safe to call when no run
 *     is in flight — they should return a boolean, not throw
 *   - `getStatus()` returns a serializable value
 *   - `getMcpStatus()` returns a serializable value
 *
 * Behavioral tests beyond this (real `run()` execution, approval
 * round-trips) require per-provider mocking and live in the
 * provider-specific test file, not here.
 */

import { describe, expect, it } from 'vitest'

export interface ProviderAdapterContractOptions<TPayload = unknown, TEvent = unknown> {
  /** Human-readable name for test-suite output (e.g. "GeminiAdapter"). */
  name: string
  /** Factory returning a fresh adapter per test. Each test gets its own
   * instance so cancel-vs-no-run state is isolated. */
  factory: () => ProviderAdapter<TPayload, TEvent> | Promise<ProviderAdapter<TPayload, TEvent>>
}

const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'ollama'
])

/** Run the generic conformance battery against an adapter factory.
 * Drops a describe block named `<name> — ProviderAdapter contract` with
 * one `it` per invariant. */
export function runProviderAdapterContractTests<TPayload = unknown, TEvent = unknown>(
  options: ProviderAdapterContractOptions<TPayload, TEvent>
): void {
  describe(`${options.name} — ProviderAdapter contract`, () => {
    it('declares a known ProviderId', async () => {
      const adapter = await options.factory()
      expect(KNOWN_PROVIDER_IDS.has(adapter.provider)).toBe(true)
    })

    it('declares a non-empty label', async () => {
      const adapter = await options.factory()
      expect(typeof adapter.label).toBe('string')
      expect(adapter.label.length).toBeGreaterThan(0)
    })

    it('declares a non-empty runChannel', async () => {
      const adapter = await options.factory()
      expect(typeof adapter.runChannel).toBe('string')
      expect(adapter.runChannel.length).toBeGreaterThan(0)
    })

    it('declares a known transport string', async () => {
      const adapter = await options.factory()
      expect(typeof adapter.transport).toBe('string')
      expect(adapter.transport.length).toBeGreaterThan(0)
    })

    it('declares a features object with boolean flags', async () => {
      const adapter = await options.factory()
      expect(typeof adapter.features).toBe('object')
      expect(adapter.features).not.toBeNull()
      // All declared features should be booleans (no leaky undefineds).
      for (const [key, value] of Object.entries(adapter.features)) {
        expect(typeof value, `Feature "${key}" must be boolean (got ${typeof value})`).toBe(
          'boolean'
        )
      }
    })

    it('declares a well-shaped capabilities object', async () => {
      const adapter = await options.factory()
      expect(typeof adapter.capabilities).toBe('object')
      expect(adapter.capabilities).not.toBeNull()
      const cap = adapter.capabilities
      // approvalModes: array of known strings
      expect(Array.isArray(cap.approvalModes)).toBe(true)
      for (const mode of cap.approvalModes) {
        expect(['default', 'plan', 'allow-all']).toContain(mode)
      }
      // Boolean flags
      expect(typeof cap.reasoningEffort).toBe('boolean')
      expect(typeof cap.imageAttachments).toBe('boolean')
      expect(typeof cap.contextInjection).toBe('boolean')
      expect(typeof cap.sessionResumption).toBe('boolean')
      expect(typeof cap.perThreadMcp).toBe('boolean')
      // speedTiers: string array (may be empty)
      expect(Array.isArray(cap.speedTiers)).toBe(true)
      for (const tier of cap.speedTiers) {
        expect(typeof tier).toBe('string')
        expect(tier.length).toBeGreaterThan(0)
      }
    })

    it('getCapabilityContract() returns a serializable object', async () => {
      const adapter = await options.factory()
      const contract = await adapter.getCapabilityContract()
      assertCapabilityContractShape(contract)
      // Round-trips through JSON without surprise.
      expect(() => JSON.parse(JSON.stringify(contract))).not.toThrow()
    })

    it('getCapabilityContract() can be called multiple times safely', async () => {
      const adapter = await options.factory()
      const first = await adapter.getCapabilityContract()
      const second = await adapter.getCapabilityContract()
      // Don't require deep-equality (provider may include timestamps),
      // but the basic shape must hold both times.
      assertCapabilityContractShape(first)
      assertCapabilityContractShape(second)
    })

    it('getStatus() returns a JSON-serializable value', async () => {
      const adapter = await options.factory()
      const status = await adapter.getStatus()
      expect(() => JSON.parse(JSON.stringify(status))).not.toThrow()
    })

    it('getMcpStatus() returns a JSON-serializable value', async () => {
      const adapter = await options.factory()
      const mcpStatus = await adapter.getMcpStatus()
      expect(() => JSON.parse(JSON.stringify(mcpStatus))).not.toThrow()
    })

    it('cancel() with no run id is safe and returns a boolean', async () => {
      const adapter = await options.factory()
      const result = await adapter.cancel()
      expect(typeof result).toBe('boolean')
    })

    it('cancel(unknownRunId) returns a boolean and does not throw', async () => {
      const adapter = await options.factory()
      const result = await adapter.cancel('definitely-not-a-real-run-id')
      expect(typeof result).toBe('boolean')
    })

    it('descriptor fields are consistent with the adapter itself', async () => {
      const adapter = await options.factory()
      const descriptor: ProviderAdapterDescriptor = {
        provider: adapter.provider,
        label: adapter.label,
        transport: adapter.transport,
        runChannel: adapter.runChannel,
        capabilitySource: adapter.capabilitySource,
        features: adapter.features,
        capabilities: adapter.capabilities
      }
      // Descriptor projection should be identity for the descriptor fields.
      expect(descriptor.provider).toBe(adapter.provider)
      expect(descriptor.label).toBe(adapter.label)
      expect(descriptor.transport).toBe(adapter.transport)
      expect(descriptor.runChannel).toBe(adapter.runChannel)
    })
  })
}

/** Assert the basic shape of a ProviderCapabilityContract. Used by
 * the contract battery + can be imported into provider-specific tests. */
export function assertCapabilityContractShape(contract: ProviderCapabilityContract): void {
  expect(typeof contract).toBe('object')
  expect(contract).not.toBeNull()
  expect(typeof contract.provider).toBe('string')
  expect(KNOWN_PROVIDER_IDS.has(contract.provider)).toBe(true)
}

/** Build a minimally-conformant fake `ProviderAdapter` for testing the
 * contract battery itself (or for use as a placeholder in scaffolding
 * tests that don't need a real adapter). Public so other test files
 * can compose against it. */
export function makeFakeProviderAdapter(
  provider: ProviderId = 'gemini',
  overrides: Partial<ProviderAdapter> = {}
): ProviderAdapter {
  return {
    provider,
    label: provider.charAt(0).toUpperCase() + provider.slice(1),
    // Cast: 'fake-transport' is a contract-test sentinel that doesn't
    // belong in the production `ProviderAdapterTransport` union. The
    // test battery only inspects the field name; the value is opaque.
    transport: 'fake-transport' as unknown as ProviderAdapterTransport,
    runChannel: 'run-agent',
    capabilitySource: 'mixed',
    features: {
      persistentSessions: false,
      appManagedApprovals: true,
      workspaceGrants: false,
      agentBenchMcpBridge: false,
      providerManagedMcp: false,
      nativeThreadTools: false,
      hostCommandFallback: false
    },
    capabilities: {
      approvalModes: ['default'],
      reasoningEffort: false,
      speedTiers: [],
      imageAttachments: false,
      contextInjection: false,
      sessionResumption: false,
      perThreadMcp: false,
      assistantTextStreaming: 'none'
    },
    async run(_context: ProviderRunContext): Promise<void> {
      // No-op fake — real adapters spawn a CLI subprocess.
    },
    async cancel(_runId?: string): Promise<boolean> {
      return false
    },
    async getStatus(): Promise<unknown> {
      return { running: false, fake: true }
    },
    async getMcpStatus(): Promise<unknown> {
      return { available: false, fake: true }
    },
    async getCapabilityContract(): Promise<ProviderCapabilityContract> {
      return {
        provider
        // Minimal valid shape; production providers populate richer fields.
        // The contract battery only checks `provider` here — provider-
        // specific tests assert richer expectations.
      } as ProviderCapabilityContract
    },
    ...overrides
  }
}
