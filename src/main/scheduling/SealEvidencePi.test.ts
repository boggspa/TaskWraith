import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildPiProcessEnv,
  buildPiRpcArgs,
  PI_READ_ONLY_TOOLS,
  PI_WRITE_TOOLS
} from '../pi/PiCliArgs'
import {
  assertPiLaunchAuthorityInvariants,
  normalizePiLaunchControls
} from '../pi/PiLaunchAuthority'
import { createPiIsolatedHome, type PiIsolatedHomeLease } from '../pi/PiIsolatedHome'
import { buildPiCredentialEnv } from '../pi/PiModelPolicy'
import { SealEvidenceFileHasher, canonicalEvidenceEncode } from './SealEvidenceCore'
import { SealEvidenceVersionProbe } from './SealEvidenceCommon'
import {
  buildPiSealEvidence,
  resolvePiSealEvidence,
  type PiSealEvidenceDeps,
  type PiSealEvidenceFacts
} from './SealEvidencePi'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-pi-seal-evidence-'))
const BINARY = join(TEMP_ROOT, 'pi')
const SESSION_DIR = join(TEMP_ROOT, 'user-data', 'pi-sessions', 'chat-1')
const API_KEY = 'SECRET-DEEPSEEK-KEY'
const isolatedHomes: PiIsolatedHomeLease[] = []

writeFileSync(
  BINARY,
  Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('pi-test')])
)

afterAll(() => {
  for (const isolatedHome of isolatedHomes) isolatedHome.cleanup()
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function isolatedHome(runId = 'run-1'): PiIsolatedHomeLease {
  const lease = createPiIsolatedHome({ temporaryRoot: TEMP_ROOT, runId })
  isolatedHomes.push(lease)
  return lease
}

function deps(providerCalls?: string[]): PiSealEvidenceDeps {
  const key = Buffer.alloc(32, 71)
  return {
    hasher: new SealEvidenceFileHasher(),
    versionProbe: new SealEvidenceVersionProbe(async () => '0.82.1-test'),
    appVersion: '1.8.9-test',
    authorityRoot: {
      providerLaunchHmac: (provider, payload) => {
        providerCalls?.push(provider)
        return createHmac('sha256', key).update(`provider:${provider}`).update(payload).digest('hex')
      }
    }
  }
}

function facts(overrides: Partial<PiSealEvidenceFacts> = {}): PiSealEvidenceFacts {
  return {
    model: 'deepseek/deepseek-v4-flash',
    promptEnvelope: {
      contextualPrompt: 'Inspect the workspace without changing it.',
      finalPrompt: 'Inspect the workspace.',
      runtimePreambleVersion: null
    },
    binaryPath: BINARY,
    baseSpawnEnv: {
      PATH: '/usr/bin',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TASKWRAITH_PARENT_PROVIDER: 'pi',
      TASKWRAITH_RUN_ID: 'run-1',
      TASKWRAITH_CHAT_ID: 'chat-1',
      TASKWRAITH_WORKSPACE_PATH: '/workspace',
      ANTHROPIC_API_KEY: 'SHOULD-BE-REMOVED',
      OPENAI_API_KEY: 'SHOULD-ALSO-BE-REMOVED',
      ZAI_API_KEY: 'PARENT-ENV-MUST-NOT-WIDEN'
    },
    upstreamApiKey: API_KEY,
    approvalMode: 'plan',
    chatId: 'chat-1',
    sessionDir: SESSION_DIR,
    isolatedHome: isolatedHome(),
    ephemeralSession: false,
    capabilityContract: {
      provider: 'pi',
      nativeContainment: 'tool-allowlist'
    },
    userMcpConfiguration: { servers: [] },
    ...overrides
  }
}

describe('Pi scheduled launch evidence', () => {
  it('internally binds every evidence HMAC to the Pi authority-root provider domain', async () => {
    const providers: string[] = []
    await buildPiSealEvidence(deps(providers), facts())
    expect(providers.length).toBeGreaterThan(0)
    expect(new Set(providers)).toEqual(new Set(['pi']))
  })

  it('matches production argv, env firewall, isolated home, and durable session behavior', async () => {
    const input = facts()
    const result = await resolvePiSealEvidence(deps(), input)

    expect(result.args).toEqual(
      buildPiRpcArgs({
        upstream: 'deepseek',
        modelId: 'deepseek-v4-flash',
        writeCapable: false,
        sessionDir: SESSION_DIR,
        sessionId: 'taskwraith-chat-1'
      })
    )
    expect(result.args[result.args.indexOf('--tools') + 1]).toBe(PI_READ_ONLY_TOOLS.join(','))
    expect(result.args).toContain('--no-approve')
    expect(result.args).toContain('--no-context-files')
    expect(result.args).toContain('--no-extensions')
    expect(result.args).toContain('--no-skills')
    expect(result.args).toContain('--no-prompt-templates')
    expect(result.args).toContain('--offline')

    const productionFirewalled = buildPiCredentialEnv(input.baseSpawnEnv, {
      deepseek: API_KEY
    })
    // Field-for-field mirror of runPiProvider's current manual env assembly.
    // The second assertion also pins PiCliArgs' extracted pure helper to that
    // production shape so dispatch can safely adopt it before seal wiring.
    const productionEnv: Record<string, string> = {}
    for (const [name, value] of Object.entries(productionFirewalled)) {
      if (typeof value === 'string') productionEnv[name] = value
    }
    productionEnv.PI_CODING_AGENT_DIR = input.isolatedHome.path
    productionEnv.PI_TELEMETRY = '0'
    productionEnv.PI_SKIP_VERSION_CHECK = '1'
    productionEnv.PI_OFFLINE = '1'
    expect(
      buildPiProcessEnv({
        credentialEnv: productionFirewalled,
        isolatedHomeDir: input.isolatedHome.path
      })
    ).toEqual(productionEnv)
    expect(result.resolvedEnv).toEqual(productionEnv)
    expect(result.resolvedEnv).toEqual(
      buildPiProcessEnv({
        credentialEnv: productionFirewalled,
        isolatedHomeDir: input.isolatedHome.path
      })
    )
    expect(result.resolvedEnv.DEEPSEEK_API_KEY).toBe(API_KEY)
    expect(result.resolvedEnv.ZAI_API_KEY).toBeUndefined()
    expect(result.resolvedEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(result.resolvedEnv.OPENAI_API_KEY).toBeUndefined()
    expect(result.resolvedEnv.PI_CODING_AGENT_DIR).toBe(input.isolatedHome.path)
    expect(result.resolvedEnv.PI_TELEMETRY).toBe('0')
    expect(result.resolvedEnv.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(result.resolvedEnv.PI_OFFLINE).toBe('1')

    expect(result.sessionId).toBe('taskwraith-chat-1')
    expect(result.authority.common.sessionMode).toBe('resume')
    expect(result.authority.common.resumeSessionHmac).toMatch(/^[a-f0-9]{64}$/)
    expect(result.authority.controls.sessionPersistence).toBe('durable-per-chat')
    expect(result.authority.controls.sessionDirectoryHmac).toMatch(/^[a-f0-9]{64}$/)
    expect(result.authority.controls.isolatedHomeAuthoritySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.authority.runtime.executableVersion).toBe('0.82.1-test')
    expect(normalizePiLaunchControls(result.authority.controls)).toEqual(result.authority.controls)
    expect(() => assertPiLaunchAuthorityInvariants(result.authority)).not.toThrow()
  })

  it('keeps every non-default approval mode read-only and binds the exact tool policy', async () => {
    const readOnlyDigests = new Set<string>()
    for (const approvalMode of ['plan', 'acceptEdits', 'auto_edit', 'never']) {
      const authority = await buildPiSealEvidence(deps(), facts({ approvalMode }))
      expect(authority.controls.writeCapable, approvalMode).toBe(false)
      expect(authority.controls.nativeToolPolicySha256).toBe(authority.tools.nativeToolPolicySha256)
      readOnlyDigests.add(authority.tools.nativeToolPolicySha256)
    }
    expect(readOnlyDigests.size).toBe(1)

    const write = await buildPiSealEvidence(deps(), facts({ approvalMode: 'default' }))
    const writeResult = await resolvePiSealEvidence(deps(), facts({ approvalMode: 'default' }))
    expect(write.controls.writeCapable).toBe(true)
    expect(writeResult.args[writeResult.args.indexOf('--tools') + 1]).toBe(PI_WRITE_TOOLS.join(','))
    expect(write.tools.nativeToolPolicySha256).not.toBe([...readOnlyDigests][0])
  })

  it.each([
    [
      'read-only',
      {
        readOnly: true,
        agenticServices: { shellCommands: 'allow' as const, fileChanges: 'allow' as const }
      }
    ],
    [
      'shell-command deny',
      {
        readOnly: false,
        agenticServices: { shellCommands: 'deny' as const, fileChanges: 'allow' as const }
      }
    ],
    [
      'file-change deny',
      {
        readOnly: false,
        agenticServices: { shellCommands: 'allow' as const, fileChanges: 'deny' as const }
      }
    ]
  ])(
    'downgrades default mode to the read-only allowlist for a signed %s posture',
    async (_label, effectivePermissions) => {
      const result = await resolvePiSealEvidence(
        deps(),
        facts({
          approvalMode: 'default',
          effectivePermissions
        })
      )

      expect(result.authority.controls.writeCapable).toBe(false)
      expect(result.args[result.args.indexOf('--tools') + 1]).toBe(PI_READ_ONLY_TOOLS.join(','))
      expect(result.args[result.args.indexOf('--tools') + 1]).not.toContain('bash')
      expect(result.args[result.args.indexOf('--tools') + 1]).not.toContain('write')
    }
  )

  it('uses --no-session and fresh authority for ephemeral ensemble lanes', async () => {
    const result = await resolvePiSealEvidence(deps(), facts({ ephemeralSession: true }))
    expect(result.args).toContain('--no-session')
    expect(result.args).not.toContain('--session-dir')
    expect(result.args).not.toContain('--session-id')
    expect(result.sessionId).toBeNull()
    expect(result.authority.common).toMatchObject({
      sessionMode: 'fresh',
      resumeSessionHmac: null,
      providerSessionGenerationSha256: null
    })
    expect(result.authority.controls).toMatchObject({
      sessionPersistence: 'ephemeral-ensemble',
      sessionDirectoryHmac: null
    })
    expect(() => assertPiLaunchAuthorityInvariants(result.authority)).not.toThrow()
  })

  it('placeholds prompt and route bytes while keyed authority changes with each secret route', async () => {
    const first = await resolvePiSealEvidence(deps(), facts())
    const changedPrompt = await resolvePiSealEvidence(
      deps(),
      facts({
        promptEnvelope: {
          ...facts().promptEnvelope,
          contextualPrompt: 'A completely different prompt.'
        }
      })
    )
    const changedRoute = await resolvePiSealEvidence(
      deps(),
      facts({
        chatId: 'chat-2',
        sessionDir: join(TEMP_ROOT, 'user-data', 'pi-sessions', 'chat-2'),
        isolatedHome: isolatedHome('run-2'),
        baseSpawnEnv: {
          ...facts().baseSpawnEnv,
          TASKWRAITH_RUN_ID: 'run-2',
          TASKWRAITH_CHAT_ID: 'chat-2'
        }
      })
    )
    const rotatedKey = await resolvePiSealEvidence(
      deps(),
      facts({ upstreamApiKey: 'ROTATED-DEEPSEEK-KEY' })
    )

    expect(changedPrompt.authority.runtime.launchArgsTemplateSha256).toBe(
      first.authority.runtime.launchArgsTemplateSha256
    )
    expect(changedPrompt.authority.common.promptEnvelopeSha256).not.toBe(
      first.authority.common.promptEnvelopeSha256
    )
    expect(changedRoute.authority.runtime.launchArgsTemplateSha256).toBe(
      first.authority.runtime.launchArgsTemplateSha256
    )
    expect(changedRoute.authority.common.launchEnvironmentHmac).not.toBe(
      first.authority.common.launchEnvironmentHmac
    )
    expect(changedRoute.authority.controls.sessionDirectoryHmac).not.toBe(
      first.authority.controls.sessionDirectoryHmac
    )
    expect(rotatedKey.authority.common.credentialStateHmac).not.toBe(
      first.authority.common.credentialStateHmac
    )
    expect(rotatedKey.authority.common.launchEnvironmentHmac).not.toBe(
      first.authority.common.launchEnvironmentHmac
    )

    const encoded = canonicalEvidenceEncode(first.authority)
    expect(encoded).not.toContain(API_KEY)
    expect(encoded).not.toContain('Inspect the workspace')
    expect(encoded).not.toContain(SESSION_DIR)
    expect(encoded).not.toContain(first.resolvedEnv.PI_CODING_AGENT_DIR)
  })

  it('hardcodes absent MCP, stdin JSONL, EOF settlement, and no fallback', async () => {
    const { authority, stdinInitialLine } = await resolvePiSealEvidence(deps(), facts())
    expect(authority.tools).toMatchObject({
      taskWraithMcpAdvertised: false,
      taskWraithMcpProfileId: null
    })
    expect(authority.controls).toMatchObject({
      transport: 'rpc',
      promptTransport: 'stdin-jsonl',
      providerApprovalMode: 'disabled',
      taskWraithMcpAttachmentMode: 'none',
      projectConfigurationDiscovery: 'disabled',
      isolatedHomeMode: 'per-run-mkdtemp-verified-v1',
      offlineStartup: true,
      telemetryEnabled: false,
      fallbackPolicy: 'forbid'
    })
    expect(JSON.parse(stdinInitialLine)).toEqual({
      type: 'prompt',
      message: 'Inspect the workspace without changing it.'
    })
    expect(authority.controls.stdinCommandTemplateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(authority.controls.shutdownPolicySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(authority.controls.credentialFirewallSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects malformed schema controls and durable/ephemeral contradictions', async () => {
    const authority = await buildPiSealEvidence(deps(), facts())
    expect(() => normalizePiLaunchControls({ ...authority.controls, extra: true })).toThrow(
      /invalid field set/i
    )
    expect(() => normalizePiLaunchControls({ ...authority.controls, upstream: 'openai' })).toThrow(
      /allowlist/i
    )
    expect(() =>
      assertPiLaunchAuthorityInvariants({
        ...authority,
        controls: {
          ...authority.controls,
          sessionPersistence: 'ephemeral-ensemble',
          sessionDirectoryHmac: null
        }
      })
    ).toThrow(/ephemeral/i)
    expect(() =>
      assertPiLaunchAuthorityInvariants({
        ...authority,
        tools: {
          ...authority.tools,
          taskWraithMcpAdvertised: true,
          taskWraithMcpProfileId: 'taskwraith-gateway-v2'
        }
      })
    ).toThrow(/cannot advertise/i)
  })
})
