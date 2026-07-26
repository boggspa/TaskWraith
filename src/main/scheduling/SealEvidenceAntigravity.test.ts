import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
import {
  buildAgyReadOnlyPrintArgs,
  buildAgyWriteCapablePrintArgs
} from '../antigravity/AntigravityCli'
import { isAntigravityGeminiApiModelCandidate } from '../antigravity/AntigravityCombinedModeDispatch'
import {
  antigravityLaunchAuthorityDigest,
  buildAntigravityLaunchAuthority
} from './AntigravityLaunchAuthority'
import {
  ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS,
  antigravityScheduledEvidenceRoute,
  buildAntigravitySealEvidence,
  type AntigravityGeminiApiSealEvidenceFacts,
  type AntigravityOfficialAgySealEvidenceFacts,
  type AntigravitySealEvidenceDeps,
  type AntigravitySealEvidenceOutcome
} from './SealEvidenceAntigravity'
import {
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceFileHasher,
  canonicalEvidenceEncode,
  launchArgsTemplateSha256
} from './SealEvidenceCore'

const temporaryDirectories: string[] = []
const CONVERSATION_ID = '123e4567-e89b-12d3-a456-426614174000'
const AGENTIC_SERVICES = {
  shellCommands: 'allow',
  fileChanges: 'allow',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  canvasEval: 'ask',
  networkAccess: 'allow'
} as const

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(...parts: Array<string | Buffer>): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

function evidenceDeps(providerCalls?: string[]): AntigravitySealEvidenceDeps {
  return {
    appVersion: '1.8.9-test',
    hasher: new SealEvidenceFileHasher(),
    authorityRoot: {
      providerLaunchHmac: (provider, payload) => {
        providerCalls?.push(provider)
        return sha256(`provider:${provider}:`, payload)
      }
    }
  }
}

function createAgyFixture(contents = '#!/bin/sh\nexit 0\n'): {
  binaryPath: string
  facts: AntigravityOfficialAgySealEvidenceFacts
} {
  const directory = temporaryDirectory('tw-antigravity-agy-seal-')
  const binaryPath = join(directory, 'agy')
  writeFileSync(binaryPath, contents)
  chmodSync(binaryPath, 0o755)
  return {
    binaryPath,
    facts: {
      lane: 'official-agy',
      model: 'claude-sonnet-4-5',
      promptEnvelope: {
        contextualPrompt: 'Review this workspace.',
        finalPrompt: 'Review this workspace.',
        runtimePreambleVersion: 'taskwraith-runtime-v1'
      },
      settings: {
        antigravityEnabled: true,
        antigravityOptInAcceptedAt: 1_700_000_000_000,
        agenticServices: AGENTIC_SERVICES
      },
      reasoningEffort: 'high',
      approvalMode: 'default',
      effectivePermissions: { readOnly: false },
      conversationId: CONVERSATION_ID,
      inheritedEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/agy-home',
        GEMINI_API_KEY: 'must-not-reach-agy',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/must-not-reach-agy.json'
      },
      resolveBinary: async () => ({ binaryPath, source: 'path' }),
      verifyBinaryProvenance: async () => ({
        state: 'verified',
        teamId: 'EQHXZ8M8AV',
        authority: 'Developer ID Application: Google LLC (EQHXZ8M8AV)'
      }),
      capabilityContract: {
        kind: 'antigravity-capability-contract',
        fileChanges: 'allow'
      },
      userMcpConfiguration: { servers: [] }
    }
  }
}

function createApiFixture(apiKey = 'AIza-test-secret-one'): {
  facts: AntigravityGeminiApiSealEvidenceFacts
  sdkEntrypointPath: string
} {
  const directory = temporaryDirectory('tw-antigravity-api-seal-')
  const hostExecutablePath = join(directory, 'electron-host')
  const sdkDirectory = join(directory, 'node_modules', '@google', 'genai')
  const sdkPackageJsonPath = join(sdkDirectory, 'package.json')
  const sdkEntrypointPath = join(sdkDirectory, 'dist', 'index.js')
  mkdirSync(join(sdkDirectory, 'dist'), { recursive: true })
  writeFileSync(hostExecutablePath, 'electron-host-runtime-v1')
  writeFileSync(
    sdkPackageJsonPath,
    JSON.stringify({ name: '@google/genai', version: '2.4.0', main: 'dist/index.js' })
  )
  writeFileSync(sdkEntrypointPath, 'export class GoogleGenAI {}')
  return {
    sdkEntrypointPath,
    facts: {
      lane: 'gemini-api',
      model: 'gemini-api:gemini-2.5-flash',
      promptEnvelope: {
        contextualPrompt: 'Continue from the exact prior turn.',
        finalPrompt: 'Continue.',
        runtimePreambleVersion: 'taskwraith-runtime-v1'
      },
      settings: {
        antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_100
      },
      secretStore: {
        loadApiKey: () => ({ status: 'ok', value: apiKey })
      },
      resolvedHostEnv: {
        PATH: '/usr/bin:/bin',
        HTTPS_PROXY: 'http://127.0.0.1:8080'
      },
      hostExecutablePath,
      hostRuntimeVersion: {
        electron: '39.2.6',
        node: '22.19.1',
        platform: 'darwin-arm64'
      },
      sdkPackageJsonPath,
      sdkEntrypointPath,
      priorChat: {
        id: 'chat-ag-api',
        provider: 'antigravity',
        scope: 'workspace',
        messages: [
          {
            id: 'prior-user',
            role: 'user',
            content: 'Remember this number: 42.',
            timestamp: '2026-07-26T00:00:00.000Z'
          },
          {
            id: 'prior-assistant',
            role: 'assistant',
            content: 'I will remember 42.',
            timestamp: '2026-07-26T00:00:01.000Z'
          }
        ]
      } as unknown as ChatRecord,
      ensembleSeatTurn: false,
      imageCount: 0,
      mcpToolDefinitions: [
        {
          name: 'read_file',
          description: 'Read a workspace file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      ],
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: 'taskwraith-core-v1',
      capabilityContract: {
        kind: 'antigravity-gemini-api-capability-contract',
        mcpTools: 'ask'
      },
      userMcpConfiguration: { servers: [] }
    }
  }
}

function requireEvidence(
  outcome: AntigravitySealEvidenceOutcome
): Extract<AntigravitySealEvidenceOutcome, { ok: true }> {
  if (outcome.ok !== true) throw new Error(`Expected evidence, received ${outcome.reason}`)
  return outcome
}

describe('AntiGravity scheduled evidence route', () => {
  it('internally binds every evidence HMAC to the AntiGravity root domain', async () => {
    const providers: string[] = []
    const fixture = createApiFixture()
    requireEvidence(await buildAntigravitySealEvidence(evidenceDeps(providers), fixture.facts))
    expect(providers.length).toBeGreaterThan(0)
    expect(new Set(providers)).toEqual(new Set(['antigravity']))
  })

  it.each([
    ['gemini-api:gemini-2.5-flash', 'gemini-api'],
    ['  GEMINI-API:GEMINI-2.5-FLASH  ', 'skipped'],
    ['gemini-api:', 'skipped'],
    ['gemini-api gemini-2.5-flash', 'skipped'],
    ['gemini-apix', 'official-agy'],
    ['claude-sonnet-4-5', 'official-agy'],
    ['cli-default', 'official-agy']
  ])('matches combined-mode quarantine for %s without falling lanes', (model, expected) => {
    const route = antigravityScheduledEvidenceRoute({ model })
    expect(isAntigravityGeminiApiModelCandidate(model)).toBe(expected !== 'official-agy')
    expect(route.kind).toBe(expected)
  })

  it('keeps image-bearing Gemini API turns as an explicit unsealed skip', () => {
    expect(
      antigravityScheduledEvidenceRoute({
        model: 'gemini-api:gemini-2.5-flash',
        imageCount: 1
      })
    ).toEqual({
      kind: 'skipped',
      reason:
        'AntiGravity Gemini API image uploads are not seal-wired yet; dispatching under the existing signed posture without claiming exact image transport evidence.'
    })
  })

  it('does not seal a malformed attachment count as image-free', () => {
    expect(
      antigravityScheduledEvidenceRoute({
        model: 'gemini-api:gemini-2.5-flash',
        imageCount: -1
      })
    ).toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('attachment evidence is malformed')
    })
  })
})

describe('official agy scheduled launch evidence', () => {
  it('re-derives the exact sandboxed argv/env and records, but does not gate on, provenance', async () => {
    const fixture = createAgyFixture()
    const outcome = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), fixture.facts)
    )
    expect(outcome.effectiveBinary).toBe(realpathSync(fixture.binaryPath))
    expect(outcome.effectivePersistence).toBe('ephemeral')
    expect(outcome.resolvedEnv).not.toHaveProperty('GEMINI_API_KEY')
    expect(outcome.resolvedEnv).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
    expect(outcome.evidence.controls).toMatchObject({
      transport: 'official-agy-cli',
      riskConsentAcceptedAt: 1_700_000_000_000,
      binaryProvenanceState: 'verified',
      binaryProvenanceTeamId: 'EQHXZ8M8AV',
      permissionMode: 'accept-edits',
      selectedModel: 'claude-sonnet-4-5',
      reasoningEffort: 'high',
      conversationMode: 'resume',
      taskWraithMcpAttachmentMode: 'none',
      fallbackPolicy: 'forbid'
    })
    const expectedArgv = buildAgyWriteCapablePrintArgs({
      prompt: SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
      model: fixture.facts.model,
      reasoningEffort: fixture.facts.reasoningEffort,
      conversationId: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
    })
    // The real arg builder rejects a placeholder conversation id, so apply the
    // same structural replacement to an accepted receipt after construction.
    const actualShape = buildAgyWriteCapablePrintArgs({
      prompt: fixture.facts.promptEnvelope.contextualPrompt,
      model: fixture.facts.model,
      reasoningEffort: fixture.facts.reasoningEffort,
      conversationId: CONVERSATION_ID
    }).map((value) =>
      value === fixture.facts.promptEnvelope.contextualPrompt
        ? SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER
        : value === CONVERSATION_ID
          ? SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
          : value
    )
    expect(expectedArgv).not.toContain(SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER)
    expect(outcome.evidence.runtime).toMatchObject({
      kind: 'cli',
      executableVersion: null,
      launchArgsTemplateSha256: launchArgsTemplateSha256(actualShape)
    })
  })

  it('keeps a reported publisher mismatch runnable while binding it into the digest', async () => {
    const verifiedFixture = createAgyFixture()
    const mismatchFixture = createAgyFixture()
    const mismatchFacts: AntigravityOfficialAgySealEvidenceFacts = {
      ...mismatchFixture.facts,
      verifyBinaryProvenance: async () => ({
        state: 'mismatch',
        teamId: 'OTHERTEAM',
        authority: 'Developer ID Application: Example Corp (OTHERTEAM)',
        detail: 'The resolved executable is signed by another team.'
      })
    }
    const verified = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), verifiedFixture.facts)
    )
    const mismatch = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), mismatchFacts)
    )
    expect(mismatch.evidence.controls).toMatchObject({
      binaryProvenanceState: 'mismatch',
      binaryProvenanceTeamId: 'OTHERTEAM'
    })
    expect(antigravityLaunchAuthorityDigest(mismatch.evidence)).not.toBe(
      antigravityLaunchAuthorityDigest(verified.evidence)
    )
  })

  it('fails evidence derivation before binary resolution when the opt-in wall is absent', async () => {
    const fixture = createAgyFixture()
    const resolveBinary = vi.fn(fixture.facts.resolveBinary)
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...fixture.facts,
        settings: {
          antigravityEnabled: true,
          antigravityOptInAcceptedAt: null,
          agenticServices: AGENTIC_SERVICES
        },
        resolveBinary
      })
    ).rejects.toThrow(/opt-in/)
    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('changes authority for consent, binary, posture, model and conversation changes', async () => {
    const baselineFixture = createAgyFixture()
    const baseline = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), baselineFixture.facts)
    )
    const baselineDigest = antigravityLaunchAuthorityDigest(baseline.evidence)

    const variants: AntigravityOfficialAgySealEvidenceFacts[] = []
    const consent = createAgyFixture()
    variants.push({
      ...consent.facts,
      settings: {
        ...consent.facts.settings!,
        antigravityOptInAcceptedAt: 1_700_000_000_001
      }
    })
    const binary = createAgyFixture('#!/bin/sh\nprintf changed\n')
    variants.push(binary.facts)
    const posture = createAgyFixture()
    variants.push({
      ...posture.facts,
      approvalMode: 'plan',
      effectivePermissions: { readOnly: true }
    })
    const model = createAgyFixture()
    variants.push({ ...model.facts, model: 'gemini-2.5-pro' })
    const conversation = createAgyFixture()
    variants.push({ ...conversation.facts, conversationId: null })

    for (const facts of variants) {
      const derived = requireEvidence(await buildAntigravitySealEvidence(evidenceDeps(), facts))
      expect(antigravityLaunchAuthorityDigest(derived.evidence)).not.toBe(baselineDigest)
    }
  })

  it('produces stable equivalent evidence for an unchanged launch plan', async () => {
    const fixture = createAgyFixture()
    const first = requireEvidence(await buildAntigravitySealEvidence(evidenceDeps(), fixture.facts))
    const second = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), fixture.facts)
    )
    expect(antigravityLaunchAuthorityDigest(second.evidence)).toBe(
      antigravityLaunchAuthorityDigest(first.evidence)
    )
  })
})

describe('Gemini API scheduled launch evidence', () => {
  it('binds the dedicated key, exact API model, SDK/host identity, history and functions', async () => {
    const apiKey = 'AIza-do-not-serialize-this-key'
    const fixture = createApiFixture(apiKey)
    const outcome = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), fixture.facts)
    )
    expect(outcome.effectiveBinary).toBe(realpathSync(fixture.facts.hostExecutablePath))
    expect(outcome.effectivePersistence).toBe('reusable')
    expect(outcome.evidence.runtime).toMatchObject({
      kind: 'in-process-sdk',
      sdkPackageJsonRealPath: realpathSync(fixture.facts.sdkPackageJsonPath),
      sdkEntrypointRealPath: realpathSync(fixture.facts.sdkEntrypointPath)
    })
    expect(outcome.evidence.controls).toMatchObject({
      transport: 'gemini-api-sdk',
      disclosureAcceptedAt: 1_700_000_000_100,
      apiModel: 'gemini-2.5-flash',
      historyMode: 'host-history-replay',
      imageTransport: 'none',
      taskWraithFunctionCalling: true,
      maxToolRounds: ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS,
      taskWraithMcpAttachmentMode: 'in-process-function-calls',
      fallbackPolicy: 'forbid'
    })
    expect(canonicalEvidenceEncode(outcome.evidence)).not.toContain(apiKey)
    expect(outcome.evidence.controls.transport).toBe('gemini-api-sdk')
    if (outcome.evidence.controls.transport !== 'gemini-api-sdk') {
      throw new Error('Expected Gemini API controls.')
    }
    expect(outcome.evidence.controls.apiKeyHmac).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes authority for key, API model, disclosure, SDK, history and tool-catalog drift', async () => {
    const baselineFixture = createApiFixture()
    const baseline = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), baselineFixture.facts)
    )
    const baselineDigest = antigravityLaunchAuthorityDigest(baseline.evidence)

    const key = createApiFixture('AIza-test-secret-two')
    const model = createApiFixture()
    const disclosure = createApiFixture()
    const sdk = createApiFixture()
    writeFileSync(sdk.sdkEntrypointPath, 'export class GoogleGenAI { changed = true }')
    const history = createApiFixture()
    const changedHistory: ChatRecord = {
      ...history.facts.priorChat!,
      messages: [
        ...history.facts.priorChat!.messages,
        {
          id: 'history-change',
          role: 'user' as const,
          content: 'New durable history.',
          timestamp: '2026-07-26T00:00:02.000Z'
        }
      ]
    }
    const tools = createApiFixture()

    for (const facts of [
      key.facts,
      { ...model.facts, model: 'gemini-api:gemini-2.5-pro' },
      {
        ...disclosure.facts,
        settings: { antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_101 }
      },
      sdk.facts,
      { ...history.facts, priorChat: changedHistory },
      {
        ...tools.facts,
        mcpToolDefinitions: [
          ...tools.facts.mcpToolDefinitions,
          {
            name: 'workspace_search',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
          }
        ]
      }
    ]) {
      const derived = requireEvidence(await buildAntigravitySealEvidence(evidenceDeps(), facts))
      expect(antigravityLaunchAuthorityDigest(derived.evidence)).not.toBe(baselineDigest)
    }
  })

  it('fails closed on missing disclosure or key and never consults static provider admission', async () => {
    const noDisclosure = createApiFixture()
    const keyLoad = vi.fn(noDisclosure.facts.secretStore.loadApiKey)
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...noDisclosure.facts,
        settings: { antigravityGeminiApiDisclosureAcceptedAt: null },
        secretStore: { loadApiKey: keyLoad }
      })
    ).rejects.toThrow(/disclosure/)
    expect(keyLoad).not.toHaveBeenCalled()

    const noKey = createApiFixture()
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...noKey.facts,
        secretStore: { loadApiKey: () => ({ status: 'missing' }) }
      })
    ).rejects.toThrow(/key is unavailable/)
  })

  it('rejects an SDK identity that is not the loaded @google/genai package boundary', async () => {
    const wrongPackage = createApiFixture()
    writeFileSync(
      wrongPackage.facts.sdkPackageJsonPath,
      JSON.stringify({ name: '@example/not-genai', version: '2.4.0' })
    )
    await expect(buildAntigravitySealEvidence(evidenceDeps(), wrongPackage.facts)).rejects.toThrow(
      /manifest is invalid/
    )

    const outsideEntrypoint = createApiFixture()
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...outsideEntrypoint.facts,
        sdkEntrypointPath: outsideEntrypoint.facts.hostExecutablePath
      })
    ).rejects.toThrow(/outside its package directory/)
  })

  it('rejects tool/profile drift instead of signing a surface the runtime does not expose', async () => {
    const fixture = createApiFixture()
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...fixture.facts,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null
      })
    ).rejects.toThrow(/function declarations diverge/)
  })

  it('returns an explicit skip for the unevidenced image path', async () => {
    const fixture = createApiFixture()
    await expect(
      buildAntigravitySealEvidence(evidenceDeps(), {
        ...fixture.facts,
        imageCount: 2
      })
    ).resolves.toMatchObject({
      ok: 'skipped',
      reason: expect.stringContaining('image uploads are not seal-wired')
    })
  })

  it('strictly rejects a forged transport swap under the same provider id', async () => {
    const fixture = createApiFixture()
    const outcome = requireEvidence(
      await buildAntigravitySealEvidence(evidenceDeps(), fixture.facts)
    )
    expect(() =>
      buildAntigravityLaunchAuthority({
        ...outcome.evidence,
        controls: {
          ...outcome.evidence.controls,
          transport: 'official-agy-cli'
        }
      } as never)
    ).toThrow()
  })
})

describe('AntiGravity evidence source equivalence guard', () => {
  it('pins the agentic API loop ceiling mirrored from GeminiApiProvider', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/GeminiApiProvider.ts'), 'utf8')
    expect(ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS).toBe(20)
    expect(source).toContain(`const MAX_TOOL_ROUNDS = ${ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS}`)
  })

  it('uses the same read-only argv builder the official dispatch preparation uses', () => {
    const args = buildAgyReadOnlyPrintArgs({
      prompt: 'prompt',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'medium'
    })
    expect(args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      '30m',
      '--model',
      'claude-sonnet-4-5',
      '--effort',
      'medium',
      '-p',
      'prompt'
    ])
  })
})
