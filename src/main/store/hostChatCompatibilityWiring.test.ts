/**
 * Wiring pins for the Host compatibility checkpoint policy in
 * `src/main/store/index.ts`, which nothing under test can import.
 *
 * The behaviour itself is tested where it lives — the interval in
 * HostChatCompatibilityPersistence.test.ts, the mutation-volume gate in
 * hostChatCompatibilityDeferral.test.ts, the liveness predicate in
 * saveFlushReason.test.ts. These assertions only prove production REACHES it.
 * That matters because the volume gate died silently once already: nine
 * deferral tests wired `getPendingMutationBytes` while the composition root
 * never did, so every real save ran unmetered and the suite stayed green.
 *
 * `MainSourceProbe` walks the AST and throws when a subject is renamed or
 * deleted, so none of these can keep passing over a moved or missing target.
 */
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'

const store = new MainSourceProbe('src/main/store/index.ts', new URL('./index.ts', import.meta.url))

describe('Host compatibility checkpoint wiring in store/index.ts', () => {
  it('constructs the one compatibility coordinator with the policy interval', () => {
    const built = store.construction('HostChatCompatibilityPersistence')
    expect(built).toHaveLength(1)
    // The env-resolved policy value, not a literal: field triage must be able
    // to widen or disable the interval without a rebuild.
    expect(store.propText(built[0], 1, 'minIntervalMs')).toBe(
      'resolveHostMaterializeMinIntervalMs()'
    )
  })

  it('meters the deferred materialization on the journal pending mutation volume', () => {
    const built = store.construction('DeferredHostMaterialization')
    expect(built).toHaveLength(1)
    const getter = store.propText(built[0], 0, 'getPendingMutationBytes')
    expect(getter).not.toBeNull()
    expect(getter).toContain('incrementalChatPersistence.pendingMutationBytes(chatId)')
  })

  it('derives run liveness from the shared status predicate, never the raw running string', () => {
    const body = store.fn('deriveSaveFlushReason')
    expect(store.callsTo(body, 'isActiveChatRunStatus')).toHaveLength(1)
    expect(store.comparesEqual(body, 'run.status', "'running'")).toBe(false)
  })

  it('carries the journal and externalization fallback intent onto the staged checkpoint', () => {
    // With a submission in flight the fallback's immediate materialize can
    // only latch; the intent on the staged entry is what lets the chained
    // successor skip the interval. Exactly one stage call passes options.
    const staged = store
      .callsTo(store.source, 'stage')
      .filter((call) => call.arguments.length === 2)
    expect(staged).toHaveLength(1)
    expect(store.propText(staged[0], 1, 'durabilityFallback')).toBe('durabilityFallback')
    expect(store.text(store.binding('durabilityFallback')).replace(/\s+/g, ' ')).toBe(
      'incrementalResult === null || preparation.externalizationFailed'
    )
  })

  it('refuses a write-gate-held materialize before it can reach the coordinator clock', () => {
    // The coordinator stamps its interval clock only on a successful enqueue,
    // so a hold must be refused HERE, before the coordinator is entered — a
    // recovery hold can then never be mistaken for a materialization.
    const body = store.fn('materializeHostChatCompatibility')
    const refused = store.guard(body, 'threadCatalogueWriteGate.isHeld(chatId)')
    expect(store.text(refused).replace(/\s+/g, ' ')).toBe('return false')
    expect(store.callsTo(body, 'materialize')).toHaveLength(1)
  })
})
