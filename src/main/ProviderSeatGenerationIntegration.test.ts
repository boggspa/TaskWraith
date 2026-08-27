import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start, `Missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `Missing end marker: ${endMarker}`).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('provider seat generation main-process integration', () => {
  it('plans after main-owned exact MCP profile resolution and rotates before dispatch', () => {
    const runtimeProfile = sourceBetween(
      'function applyRuntimeProfileToPayload(',
      'async function getCliProviderStatus('
    )
    const exactResolution = runtimeProfile.indexOf('const resolution = resolveTaskWraithMcpProfile({')
    const generation = runtimeProfile.indexOf('applyProviderSeatGeneration({')
    const fence = runtimeProfile.indexOf('refreshTaskWraithMcpProfileFenceStoreIdentity(applied)')

    expect(exactResolution).toBeGreaterThanOrEqual(0)
    expect(generation).toBeGreaterThan(exactResolution)
    expect(fence).toBeGreaterThan(generation)
    expect(runtimeProfile).toContain('providerSessionId: null')
    expect(runtimeProfile).toContain('storeProviderSessionId: null')
  })

  it('rebases a pre-dispatch Claude payload onto the current store session', () => {
    const runtimeProfile = sourceBetween(
      'function applyRuntimeProfileToPayload(',
      'async function getCliProviderStatus('
    )
    const sessionResolution = runtimeProfile.indexOf('resolveTaskWraithMcpDispatchSession({')
    const sessionRebase = runtimeProfile.indexOf(
      'applied.providerSessionId = dispatchSession.providerSessionId'
    )
    const exactProfileResolution = runtimeProfile.indexOf(
      'const resolution = resolveTaskWraithMcpProfile({'
    )

    expect(sessionResolution).toBeGreaterThanOrEqual(0)
    expect(sessionRebase).toBeGreaterThan(sessionResolution)
    expect(exactProfileResolution).toBeGreaterThan(sessionRebase)
    expect(runtimeProfile).not.toContain(
      'The Claude session changed before dispatch; retry this turn on the current session.'
    )
  })

  it('fingerprints stable seat prefix configuration without hashing user prompts', () => {
    const generationInput = sourceBetween(
      'function providerSeatGenerationInputForPayload(',
      'function saveProviderSeatGeneration('
    )

    expect(generationInput).toContain("fingerprintProviderSeatPrefix('system'")
    expect(generationInput).toContain('TASKWRAITH_RUNTIME_PREAMBLE_VERSION')
    expect(generationInput).toContain("fingerprintProviderSeatPrefix('tools'")
    expect(generationInput).not.toContain('payload.prompt')
  })

  it('normalizes posture per lane and never validates a stored session from backfilled fields', () => {
    const generationInput = sourceBetween(
      'function providerSeatGenerationInputForPayload(',
      'function saveProviderSeatGeneration('
    )
    // Both dispatch lanes must hash one semantic posture (renderer clamp
    // resolves 'default'; signed remote lane leaves it for the gate) and the
    // system tuple must come from the single shared helper.
    expect(generationInput).toContain('providerSeatPosturePrefixComponents({')
    expect(generationInput).toContain('providerSeatSystemPromptFingerprint({')
    expect(generationInput).toContain('storedSeatSessionObservationForPayload(')

    const seatApply = sourceBetween(
      'function applyProviderSeatGeneration(',
      'function refreshTaskWraithMcpProfileFenceStoreIdentity('
    )
    // The stored-session check compares recorded observations only; the old
    // inline bootstrapInput comparison backfilled unrecorded fields from the
    // current dispatch and rotated healthy CLI sessions (2026-07-28).
    expect(seatApply).toContain('storedSeatSessionRotationRequired(')
    expect(seatApply).toContain('storedSeatSessionObservationForPayload({')
    expect(seatApply).not.toContain('!== bootstrapInput.systemPromptFingerprint')
  })

  it('greppable lint: every sessionless Kimi session/new takes the recovery prompt', () => {
    // Ship-notes class (1.9.0 postmortem): prose landmines do not prevent
    // regressions — this pin is the mechanical form of the 2026-07-28 live
    // catch. buildKimiProductionSessionPlan used to select the recovery
    // prompt only for requested-but-unauthorized (legacy-posture) resumes;
    // a seat rotation nulls the requested session AFTER composition, so a
    // real rotation (k2.7→k3) opened session/new on the slim resume prompt
    // and answered "I don't have a codeword for this thread".
    const kimiPlanSource = fs.readFileSync(
      new URL('./kimi/KimiProductionContainment.ts', import.meta.url),
      'utf8'
    )
    const planBody = (() => {
      const start = kimiPlanSource.indexOf('export function buildKimiProductionSessionPlan(')
      const end = kimiPlanSource.indexOf('export function', start + 1)
      expect(start).toBeGreaterThanOrEqual(0)
      return kimiPlanSource.slice(start, end)
    })()
    // The sessionless branch must prefer the composed recovery prompt…
    expect(planBody).toContain('prompt: input.resumeFallbackPrompt || input.prompt')
    // …and must never re-gate that selection on the requested session id.
    expect(planBody).not.toMatch(/requested\s*\?\s*input\.resumeFallbackPrompt/)

    // Wiring seam: the dispatch call site must actually pass the fallback.
    // Dropping this line starves the plan silently — no unit test fails,
    // every rotated Kimi turn goes context-blind (the orphan-input class).
    const kimiDispatch = sourceBetween(
      'buildKimiProductionSessionPlan({',
      'legacyResumeRejected'
    )
    expect(kimiDispatch).toContain('resumeFallbackPrompt: payload.resumeFallbackPrompt')
  })

  it('surfaces real context-dropping rotations as a system transcript notice', () => {
    const seatApply = sourceBetween(
      'function applyProviderSeatGeneration(',
      'function refreshTaskWraithMcpProfileFenceStoreIdentity('
    )
    // A legitimate rotation (model/tools/provider change) on a CLI seat drops
    // the conversation — it must never be silent. API transports replay
    // history, and pi's chat-deterministic session ignores the rotated id, so
    // the notice gates on providerSeatRotationDropsContext (provider-aware).
    expect(seatApply).toContain('shouldRotateSession &&')
    expect(seatApply).toContain(
      'providerSeatRotationDropsContext(args.payload.provider, capability.transport)'
    )
    expect(seatApply).toContain('appendProviderSeatRotationNotice({')

    const notice = sourceBetween(
      'function appendProviderSeatRotationNotice(',
      'function saveProviderSeatGeneration('
    )
    expect(notice).toContain("role: 'system'")
    expect(notice).toContain('providerSeatRotationNoticeText({')
    expect(notice).toContain("kind: 'providerSeatRotation'")
    // Idempotent per run id so a dispatch retry cannot duplicate the row.
    expect(notice).toContain('chat.messages.some((message) => message.id === messageId)')
  })

  it('persists provider-reported cache evidence from the terminal lifecycle seam', () => {
    const listener = sourceBetween(
      'runManager.onChange((event) => {',
      'function flushBackgroundSubThreadTranscript('
    )

    expect(listener).toContain('recordProviderSeatCacheEvidenceForRun(event.session)')
    expect(indexSource).toContain('recordProviderSeatCacheEvidence(target.generation, stats')
    expect(indexSource).toContain("eventType: 'provider_seat_cache_evidence'")
  })

  it('preserves the frozen Codex startup lease and canonical gateway target dispatch', () => {
    expect(indexSource).toContain('codexAppServerStartupLeaseCount')
    expect(indexSource).toContain('shouldRestartCodexAppServerForMcpConfig')
    expect(indexSource).toContain('dispatchResolvedGatewayTarget({')
    expect(indexSource).toContain('executeCanonical: executeGeminiMcpTool')
  })
})
