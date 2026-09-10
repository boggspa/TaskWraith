import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'scheduled-seal-production-readiness-test'),
    getVersion: () => 'test'
  }
}))

import { CODEX_SCHEDULED_SEAL_READINESS } from './SealEvidenceCodex'
import { CLAUDE_SCHEDULED_SEAL_READINESS } from './SealEvidenceClaude'
import { KIMI_SCHEDULED_SEAL_READINESS } from './SealEvidenceKimi'
import { GROK_SCHEDULED_SEAL_READINESS } from './SealEvidenceGrok'
import { MISTRAL_SCHEDULED_SEAL_READINESS } from './SealEvidenceMistral'
import { OLLAMA_SCHEDULED_SEAL_READINESS } from './SealEvidenceOllama'
import { MainSourceProbe } from '../mainSourceProbe.testutil'

const indexUrl = new URL('../index.ts', import.meta.url)

/**
 * `src/main/index.ts` cannot be imported under test, so every claim below is a
 * claim about its SOURCE. The structural probe is the primary instrument: it
 * anchors on declared names, call structure and assignment targets, so a
 * renamed or deleted subject throws instead of quietly passing, and a claim
 * about (say) the Codex exec fallback can no longer be satisfied by the
 * identical line in the Claude path.
 *
 * A handful of literals survive underneath the probes. They are kept, not
 * migrated, wherever the literal carries something the probe cannot express —
 * in every case here, the `await`. Dropping an `await` in front of one of these
 * post-seal calls is a real regression, and only the literal still catches it.
 * Each such line says so at the point of use.
 */
const index = new MainSourceProbe('src/main/index.ts', indexUrl)
const indexSource = readFileSync(indexUrl, 'utf8')

const candidates = [
  CODEX_SCHEDULED_SEAL_READINESS,
  CLAUDE_SCHEDULED_SEAL_READINESS,
  KIMI_SCHEDULED_SEAL_READINESS,
  GROK_SCHEDULED_SEAL_READINESS,
  MISTRAL_SCHEDULED_SEAL_READINESS,
  OLLAMA_SCHEDULED_SEAL_READINESS
]

const SANITIZES_SEALED_PROMPT = expect.stringContaining(
  'sanitizeTaskWraithMcpPromptClaims(payload.prompt'
)

describe('scheduled seal producer production readiness', () => {
  it('keeps every non-parity producer explicitly blocked from production wiring', () => {
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      'codex',
      'claude',
      'kimi',
      'grok',
      'mistral',
      'ollama'
    ])
    for (const candidate of candidates) {
      expect(candidate.productionWiring).toBe('blocked')
      expect(candidate.blockers.length).toBeGreaterThan(0)
    }
  })

  it('records Codex post-seal transport and prompt mutation blockers', () => {
    // post-seal-exec-fallback: the app-server dispatch can still hand the run
    // to the one-shot exec transport after the seal was taken, so the sealed
    // evidence does not describe the transport that actually ran.
    const execFallback = index.callsTo(index.fn('runCodexProvider'), 'runCodexExecFallback')
    expect(execFallback).toHaveLength(1)
    expect(index.argText(execFallback[0], 0)).toBe('event')
    expect(index.argText(execFallback[0], 1)).toBe('payload')
    expect(index.argText(execFallback[0], 2)).toBe('message')
    // Kept as a literal: the probe sees the call but not the `await`. An
    // unawaited fallback would leave the run unsettled, and only this catches it.
    expect(indexSource).toContain('await runCodexExecFallback(event, payload, message)')

    // post-seal-private-home-continuity-rewrite: the private-home link rewrites
    // the prompt in place, after sealing.
    expect(
      index.assignmentsTo(index.fn('runCodexAppServerWithClient'), 'payload.prompt')
    ).toContain('preparedLink.prompt')

    // post-seal-mcp-prompt-rewrite: and the exec fallback rewrites it again,
    // stripping MCP claims the seal recorded as present. Scoped to the Codex
    // fallback so the identical line in the Claude/Grok paths cannot satisfy it.
    expect(index.assignmentsTo(index.fn('runCodexExecFallback'), 'payload.prompt')).toEqual(
      expect.arrayContaining([SANITIZES_SEALED_PROMPT])
    )

    expect(CODEX_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'post-seal-exec-fallback',
        'post-seal-private-home-continuity-rewrite',
        'post-seal-mcp-prompt-rewrite',
        'reusable-daemon-launch-generation-not-bound',
        'runtime-profile-posture-applied-after-seal'
      ])
    )
  })

  it('records Claude late transport selection and MCP degradation blockers', () => {
    const claudeProvider = index.fn('runClaudeProvider')

    // sdk-or-cli-transport-selected-after-seal: the SDK-vs-CLI decision is made
    // inside the provider entry point, i.e. after the seal, not before it.
    expect(index.callsTo(claudeProvider, 'loadOptionalClaudeSdk')).toHaveLength(1)
    // Kept as a literal: `await` again — an unawaited load hands back an
    // always-truthy promise and the transport choice flips to "SDK present".
    expect(indexSource).toContain('const sdk = await loadOptionalClaudeSdk()')

    // The user-visible consequence of that late choice: the run announces a CLI
    // fallback even though the seal recorded the SDK transport.
    expect(index.text(index.binding('claudeFallbackWarning'))).toContain(
      "'Using Claude Code CLI fallback for this run.'"
    )

    // post-seal-mcp-prompt-rewrite / post-seal-cli-print-fallback: MCP is
    // demoted after sealing, on two independent paths — the broker failing to
    // start, and the MCP config file failing to write. Both are pinned: losing
    // either one is a change to what the seal can still be trusted to describe.
    expect(index.assignmentsTo(claudeProvider, 'payload.taskWraithMcpAdvertised')).toEqual([
      'false',
      'false'
    ])

    expect(CLAUDE_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'sdk-or-cli-transport-selected-after-seal',
        'post-seal-mcp-prompt-rewrite',
        'post-seal-cli-print-fallback'
      ])
    )
  })

  it('records Kimi resume fallback and final admission blockers', () => {
    const kimiProvider = index.fn('runKimiAcpProvider')

    // resume-fallback-prompt-not-bound: the production session plan carries a
    // second, unsealed prompt that the provider may send instead.
    const sessionPlan = index.callsTo(kimiProvider, 'buildKimiProductionSessionPlan')
    expect(sessionPlan).toHaveLength(1)
    expect(index.propText(sessionPlan[0], 0, 'resumeFallbackPrompt')).toBe(
      'payload.resumeFallbackPrompt'
    )
    expect(index.propText(sessionPlan[0], 0, 'prompt')).toBe('payload.prompt')

    // isolated-home-credential-state-not-bound: the isolated home (and the
    // credential state preserved into it) is built at dispatch, unsealed.
    const isolatedHome = index.callsTo(kimiProvider, 'prepareKimiIsolatedHome')
    expect(isolatedHome).toHaveLength(1)
    expect(index.propText(isolatedHome[0], 0, 'preserveSessionState')).toBe(
      'preserveKimiSessionState'
    )
    expect(index.propText(isolatedHome[0], 0, 'homeDir')).toBe('kimiHomeDir')
    // Kept as a literal: `await` — the home must be fully prepared before the
    // run registers, which is exactly what this line pins.
    expect(indexSource).toContain('const home = await prepareKimiIsolatedHome({')

    // final-runtime-admission-not-compared-to-seal: the binary that actually
    // spawns is admitted here, at spawn time, and never compared to the seal.
    const admission = index.callsTo(kimiProvider, 'assertReadyForSpawn')
    expect(admission).toHaveLength(1)
    expect(index.text(admission[0].expression)).toBe('admittedRuntime.assertReadyForSpawn')
    // Kept as a literal: `await` — an unawaited admission would spawn on a
    // promise instead of a path.
    expect(indexSource).toContain('const binaryPath = await admittedRuntime.assertReadyForSpawn()')

    expect(KIMI_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'resume-fallback-prompt-not-bound',
        'isolated-home-credential-state-not-bound',
        'final-runtime-admission-not-compared-to-seal'
      ])
    )
  })

  it('records Grok final prompt and MCP degradation blockers', () => {
    const grokProvider = index.fn('runGrokAcpProviderAfterWorkspaceLockAdmission')

    // provider-visible-steered-prompt-not-bound: the text Grok actually sees is
    // derived from payload.prompt at dispatch, after the seal recorded the
    // unsteered prompt.
    const providerPrompt = index.callsTo(grokProvider, 'buildGrokProviderPrompt')
    expect(providerPrompt).toHaveLength(1)
    expect(index.argText(providerPrompt[0], 0)).toBe('payload.prompt')

    // post-seal-mcp-prompt-rewrite: broker start failure degrades the run to
    // toolless and says so, after sealing.
    const bridgeWarnings = index
      .callsTo(grokProvider, 'sendAgentCompatLine')
      .filter((call) => index.propText(call, 2, 'title') === "'Grok MCP bridge unavailable'")
    expect(bridgeWarnings).toHaveLength(1)
    expect(index.propText(bridgeWarnings[0], 2, 'type')).toBe("'provider_warning'")
    expect(index.assignmentsTo(grokProvider, 'payload.prompt')).toEqual(
      expect.arrayContaining([SANITIZES_SEALED_PROMPT])
    )

    expect(GROK_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'provider-visible-steered-prompt-not-bound',
        'post-seal-mcp-prompt-rewrite'
      ])
    )
  })

  it('shares Ollama launch resolution and records only the unwired plan handoff', () => {
    // scheduled-dispatch-does-not-carry-final-launch-plan: the main runtime is
    // wired to the same provider entry point the interactive path uses, so the
    // launch plan below is resolved at dispatch rather than at seal time.
    const ollamaRuntime = index.callsTo(
      index.binding('ollamaMainRuntime'),
      'createOllamaMainRuntime'
    )
    expect(ollamaRuntime).toHaveLength(1)
    expect(index.propText(ollamaRuntime[0], 0, 'runProvider')).toBe('runOllamaProvider')

    // These two modules are importable, so the claims below still belong in
    // real-input tests against the modules themselves; they are recorded here
    // only as the shared launch resolution that leaves the plan handoff as the
    // one unwired step, and they are not index.ts claims. Until they move, the
    // probe applies to them exactly as it does to index.ts — it takes any
    // source file — so each claim anchors on a declared name, a call or a
    // property assignment instead of a substring that a like-named line
    // anywhere in a five-thousand-line module could satisfy.
    const runtimeUrl = new URL('../ollama/OllamaProvider.ts', import.meta.url)
    const planUrl = new URL('../ollama/OllamaLaunchPlan.ts', import.meta.url)
    const runtime = new MainSourceProbe('OllamaProvider.ts', runtimeUrl)
    const plan = new MainSourceProbe('OllamaLaunchPlan.ts', planUrl)
    const runtimeSource = readFileSync(runtimeUrl, 'utf8')
    const planSource = readFileSync(planUrl, 'utf8')
    const ollamaRun = runtime.fn('runOllamaProvider')
    const resolveLaunchPlan = plan.fn('resolveOllamaFinalLaunchPlan')

    // The provider entry point resolves the plan itself — the resolution that
    // interactive and scheduled runs share.
    expect(runtime.callsTo(ollamaRun, 'resolveOllamaFinalLaunchPlan')).toHaveLength(1)
    // Kept as a literal: the probe sees the call but not the `await`. An
    // unawaited resolve binds a promise, and every plan field read below it
    // silently becomes undefined.
    expect(runtimeSource).toContain('const launchPlan = await resolveOllamaFinalLaunchPlan(')
    // The run reads the model manifest off that plan rather than re-deriving it.
    expect(runtime.text(runtime.binding('modelInfo'))).toBe('launchPlan.modelManifest.merged')

    // What the plan resolves for the first request: the installed wire model,
    // the daemon's own /api/show manifest, the native tool surface, and the
    // keyed session memory. Each is scoped to the resolver, so an identically
    // named call elsewhere in the module cannot stand in for it.
    expect(plan.callsTo(resolveLaunchPlan, 'resolveOllamaRequestedWireModel')).toHaveLength(1)
    const modelShow = plan.callsTo(resolveLaunchPlan, 'loadModelShow')
    expect(modelShow).toHaveLength(1)
    expect(plan.argText(modelShow[0], 0)).toBe('model')
    // Kept as a literal: `await` — an unawaited show is cloned as a promise and
    // the merged manifest loses every field it was supposed to carry.
    expect(planSource).toContain('await deps.loadModelShow(model, {')
    expect(plan.callsTo(resolveLaunchPlan, 'buildNativeToolDefinitions')).toHaveLength(1)
    const sessionMemory = plan.callsTo(resolveLaunchPlan, 'getSessionMemory')
    expect(sessionMemory).toHaveLength(1)
    expect(plan.argText(sessionMemory[0], 0)).toBe('input.chatId')
    expect(plan.argText(sessionMemory[0], 1)).toBe('memoryKey ?? undefined')
    expect(plan.text(plan.binding('temperature'))).toBe(
      'ollamaModelFamilyTemperature(model) ?? 0.2'
    )

    // The first /api/chat body is built once, here, and carries the WIRE model
    // — the id actually sent — not the catalogue id retained in events. Read
    // per-object off the `firstRequest` binding, so no other literal in the
    // module can satisfy it.
    const firstRequest = plan.objectLiterals(plan.binding('firstRequest'))
    expect(firstRequest.length).toBeGreaterThan(0)
    expect(plan.propOf(firstRequest[0], 'model')).toBe('wireModel')

    // And production sends that exact body: spread into the run's turn-0
    // request, and handed to the transport only on turn 0. The spread is
    // scoped to the run's own `firstRequest` literal rather than the file —
    // the probe reads property assignments, not spread elements, so the
    // containment claim is narrowed to that node instead of dropped.
    expect(runtime.text(runtime.binding('firstRequest'))).toContain('...launchPlan.firstRequest')
    const chatTurn = runtime.callsTo(ollamaRun, 'runOllamaChatTurn')
    expect(chatTurn).toHaveLength(1)
    expect(runtime.propText(chatTurn[0], 0, 'request')).toBe(
      'turnIndex === 0 ? firstRequest : undefined'
    )
    expect(OLLAMA_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'scheduled-dispatch-does-not-carry-final-launch-plan',
        'mcp-profile-required-for-sealing-not-enforced-at-dispatch',
        'model-manifest-not-revalidated-at-final-use'
      ])
    )
  })
})
