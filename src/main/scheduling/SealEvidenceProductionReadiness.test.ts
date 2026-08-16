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

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

const candidates = [
  CODEX_SCHEDULED_SEAL_READINESS,
  CLAUDE_SCHEDULED_SEAL_READINESS,
  KIMI_SCHEDULED_SEAL_READINESS,
  GROK_SCHEDULED_SEAL_READINESS,
  MISTRAL_SCHEDULED_SEAL_READINESS,
  OLLAMA_SCHEDULED_SEAL_READINESS
]

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
    expect(indexSource).toContain('await runCodexExecFallback(event, payload, message)')
    expect(indexSource).toContain('payload.prompt = preparedLink.prompt')
    expect(indexSource).toContain(
      'payload.prompt = sanitizeTaskWraithMcpPromptClaims(payload.prompt'
    )
    expect(CODEX_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'post-seal-exec-fallback',
        'post-seal-private-home-continuity-rewrite',
        'post-seal-mcp-prompt-rewrite',
        'reusable-daemon-launch-generation-not-bound',
        'runtime-profile-posture-applied-after-seal',
        'full-access-native-sandbox-verifier-mismatch'
      ])
    )
  })

  it('records Claude late transport selection and MCP degradation blockers', () => {
    expect(indexSource).toContain('const sdk = await loadOptionalClaudeSdk()')
    expect(indexSource).toContain('Using Claude Code CLI fallback for this run.')
    expect(indexSource).toContain('payload.taskWraithMcpAdvertised = false')
    expect(CLAUDE_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'sdk-or-cli-transport-selected-after-seal',
        'post-seal-mcp-prompt-rewrite',
        'post-seal-cli-print-fallback'
      ])
    )
  })

  it('records Kimi resume fallback and final admission blockers', () => {
    expect(indexSource).toContain('resumeFallbackPrompt: payload.resumeFallbackPrompt')
    expect(indexSource).toContain('const binaryPath = await admittedRuntime.assertReadyForSpawn()')
    expect(indexSource).toContain('const home = await prepareKimiIsolatedHome({')
    expect(KIMI_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'resume-fallback-prompt-not-bound',
        'isolated-home-credential-state-not-bound',
        'final-runtime-admission-not-compared-to-seal'
      ])
    )
  })

  it('records Grok final prompt and MCP degradation blockers', () => {
    expect(indexSource).toContain('const grokProviderPrompt = buildGrokProviderPrompt(')
    expect(indexSource).toContain("title: 'Grok MCP bridge unavailable'")
    expect(indexSource).toContain(
      'payload.prompt = sanitizeTaskWraithMcpPromptClaims(payload.prompt'
    )
    expect(GROK_SCHEDULED_SEAL_READINESS.blockers).toEqual(
      expect.arrayContaining([
        'provider-visible-steered-prompt-not-bound',
        'post-seal-mcp-prompt-rewrite'
      ])
    )
  })

  it('shares Ollama launch resolution and records only the unwired plan handoff', () => {
    expect(indexSource).toContain('runProvider: runOllamaProvider')
    const runtimeSource = readFileSync(
      new URL('../ollama/OllamaProvider.ts', import.meta.url),
      'utf8'
    )
    const planSource = readFileSync(
      new URL('../ollama/OllamaLaunchPlan.ts', import.meta.url),
      'utf8'
    )
    expect(runtimeSource).toContain('const launchPlan = await resolveOllamaFinalLaunchPlan(')
    expect(runtimeSource).toContain('const modelInfo = launchPlan.modelManifest.merged')
    expect(planSource).toContain('resolveOllamaRequestedWireModel(')
    expect(planSource).toContain('await deps.loadModelShow(model, {')
    expect(planSource).toContain('model: wireModel')
    expect(planSource).toContain('buildNativeToolDefinitions({')
    expect(planSource).toContain('getSessionMemory(input.chatId, memoryKey')
    expect(planSource).toContain('const temperature = ollamaModelFamilyTemperature(model) ?? 0.2')
    expect(planSource).toContain('const firstRequest: Record<string, unknown> = {')
    expect(runtimeSource).toContain(
      'request: turnIndex === 0 ? launchPlan.firstRequest : undefined'
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
