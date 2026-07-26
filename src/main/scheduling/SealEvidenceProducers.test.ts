import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The Codex producer imports CodexAppServerClient, which transitively loads
// the AppStore (electron.app.getPath at module scope). Same mock shape as
// CodexAppServerClient.test.ts.
vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'taskwraith-seal-evidence-producers-test'),
    getVersion: () => 'test'
  }
}))

import {
  buildProviderLaunchAuthority,
  providerLaunchAuthorityDigest
} from '../ProviderLaunchAuthorityDigest'
import {
  buildCodexTaskWraithMcpArgs,
  type CodexMcpTaskWraithConfig
} from '../CodexAppServerClient'
import type { CodexAppServerProcessLaunchPlan } from '../codex/CodexAppServerProcessLaunchPlan'
import { buildContainedCursorReadOnlyArgv } from '../cursor/CursorCliArgs'
import { resolveOllamaFinalLaunchPlan } from '../ollama/OllamaLaunchPlan'
import type { OllamaNativeToolDefinition } from '../ollama/OllamaProvider'
import { TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE } from '../PromptComposition'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import type { AppSettings, EffectiveRunPermissions } from '../store/types'
import {
  SealEvidenceFileHasher,
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  canonicalEvidenceEncode,
  launchArgsTemplateSha256
} from './SealEvidenceCore'
import {
  SealEvidenceVersionProbe,
  deriveScheduledSeatPostureMirror,
  type SealEvidenceDeps
} from './SealEvidenceCommon'
import { buildCursorSealEvidence } from './SealEvidenceCursor'
import { buildCodexSealEvidence } from './SealEvidenceCodex'
import { buildClaudeSealEvidence } from './SealEvidenceClaude'
import { buildKimiSealEvidence } from './SealEvidenceKimi'
import { buildGrokSealEvidence } from './SealEvidenceGrok'
import { buildOllamaSealEvidence } from './SealEvidenceOllama'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'seal-evidence-producers-'))

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function codexProcessLaunchPlan(
  binaryPath: string,
  env: Record<string, string>,
  config: CodexMcpTaskWraithConfig | null
): CodexAppServerProcessLaunchPlan {
  return Object.freeze({
    transport: 'app-server',
    startupCompatibility: 'configured',
    command: binaryPath,
    args: Object.freeze([
      ...(config ? buildCodexTaskWraithMcpArgs(config) : []),
      'app-server'
    ]),
    shell: false,
    env: Object.freeze({ ...env })
  })
}

function testRoot(): ScheduledOccurrenceAuthorityRoot {
  const key = Buffer.alloc(32, 53)
  const mac = (domain: string, payload: Buffer): string =>
    createHmac('sha256', key).update(domain).update(payload).digest('hex')
  return Object.freeze({
    rootId: `twso-root-v1:${'5'.repeat(64)}`,
    sealPayloadMac: (payload: Buffer) => mac('seal', payload),
    verifySealPayloadMac: (payload: Buffer, value: string) => mac('seal', payload) === value,
    walPayloadMac: (payload: Buffer) => mac('wal', payload),
    verifyWalPayloadMac: (payload: Buffer, value: string) => mac('wal', payload) === value,
    runtimeProfileSetHmac: (payload: Buffer) => mac('runtime', payload),
    permissionPostureSetHmac: (payload: Buffer) => mac('posture', payload),
    providerLaunchHmac: (provider: string, payload: Buffer) =>
      mac(`provider:${provider}`, payload),
    verifyProviderLaunchHmac: (provider: string, payload: Buffer, value: string) =>
      mac(`provider:${provider}`, payload) === value,
    dispose: () => {}
  }) as ScheduledOccurrenceAuthorityRoot
}

function fakeBinary(name: string): string {
  const path = join(TEMP_ROOT, name)
  writeFileSync(path, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(name)]))
  return path
}

function deps(): SealEvidenceDeps {
  return {
    authorityRoot: testRoot(),
    hasher: new SealEvidenceFileHasher(),
    versionProbe: new SealEvidenceVersionProbe(async () => '9.9.9-test'),
    appVersion: '1.8.6-test'
  }
}

const PROMPT_ENVELOPE = {
  contextualPrompt: 'Contextual prompt body with transcript context.',
  finalPrompt: 'Review the workspace.',
  runtimePreambleVersion: 'taskwraith-runtime-v6'
} as const

function readOnlyPermissions(): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'deny',
      canvasInteraction: 'deny',
      canvasEval: 'deny',
      crossThreadRead: 'deny',
      threadMessage: 'deny',
      mediaEditing: 'deny',
      mediaRecording: 'deny'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true
  }
}

const WORKSPACE = join(TEMP_ROOT, 'workspace')
mkdirSync(WORKSPACE, { recursive: true })

describe('deriveScheduledSeatPostureMirror', () => {
  const settings = {
    agenticServices: {},
    agenticWorkspaceGrants: []
  } as unknown as AppSettings

  it('derives the P1 unattended read-only posture with no elevation ack', () => {
    const mirror = deriveScheduledSeatPostureMirror({
      provider: 'codex',
      workspacePath: WORKSPACE,
      requestedModel: 'gpt-5.6-terra',
      taskApprovalMode: 'auto_edit',
      workflowMode: 'normal',
      settings,
      unattendedElevationAck: null
    })
    expect(mirror.approvalMode).toBe('plan')
    expect(mirror.presetId).toBe('read_only')
    expect(mirror.effectivePermissions.readOnly).toBe(true)
    expect(mirror.effectivePermissions.presetId).toBe('read_only')
  })

  it('derives the plan-instrument tier for workflowMode plan', () => {
    const mirror = deriveScheduledSeatPostureMirror({
      provider: 'claude',
      workspacePath: WORKSPACE,
      requestedModel: 'default',
      taskApprovalMode: 'default',
      workflowMode: 'plan',
      settings,
      unattendedElevationAck: null
    })
    expect(mirror.approvalMode).toBe('plan')
    expect(mirror.presetId).toBe('plan')
  })
})

describe('cursor seal evidence', () => {
  it('builds canonical read-only launch authority from the real contained argv', async () => {
    const binary = fakeBinary('cursor-agent')
    const evidence = await buildCursorSealEvidence(deps(), {
      model: 'composer-1',
      promptEnvelope: PROMPT_ENVELOPE,
      resolvedEnv: { PATH: '/usr/bin', HOME: '/Users/test' },
      binaryPath: binary,
      workspacePath: WORKSPACE,
      writeCapable: false,
      readOnlySeat: true,
      taskWraithMcpAdvertised: false,
      cursorReasoningEffort: null,
      cursorFastMode: false,
      capabilityContract: { gates: { sandbox: 'enabled' } }
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.provider).toBe('cursor')
    expect(canonical.controls).toMatchObject({
      executionMode: 'ask',
      bridgeMode: 'none',
      brokerRegistration: 'none',
      forceMcpTools: false,
      approveMcpServers: false
    })
    expect(canonical.tools.taskWraithMcpAdvertised).toBe(false)
    expect(canonical.common.sessionMode).toBe('fresh')
    expect(canonical.runtime.kind).toBe('cli')
    expect(evidence.runtime.launchArgsTemplateSha256).toBe(
      launchArgsTemplateSha256(
        buildContainedCursorReadOnlyArgv({
          workspace: WORKSPACE,
          prompt: SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
          model: 'composer-1',
          mode: 'ask'
        })
      )
    )
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('write tier maps to contained-default with a prompt-independent argv digest', async () => {
    const binary = fakeBinary('cursor-agent-write')
    const build = (prompt: string) =>
      buildCursorSealEvidence(deps(), {
        model: 'composer-1',
        promptEnvelope: { ...PROMPT_ENVELOPE, contextualPrompt: prompt },
        resolvedEnv: { PATH: '/usr/bin' },
        binaryPath: binary,
        workspacePath: WORKSPACE,
        writeCapable: true,
        readOnlySeat: false,
        taskWraithMcpAdvertised: false,
        cursorReasoningEffort: 'medium',
        cursorFastMode: true,
        capabilityContract: {}
      })
    const evidence = await build('Contextual prompt body one.')
    const otherPrompt = await build('A completely different prompt.')
    expect(evidence.controls.executionMode).toBe('contained-default')
    expect(evidence.controls.reasoningEffort).toBeNull()
    expect(evidence.controls.fastMode).toBe(false)
    // The argv template excludes prompt bytes: different prompts, same
    // template digest — while the prompt envelope digest DOES change.
    expect(otherPrompt.runtime.launchArgsTemplateSha256).toBe(
      evidence.runtime.launchArgsTemplateSha256
    )
    expect(otherPrompt.common.promptEnvelopeSha256).not.toBe(evidence.common.promptEnvelopeSha256)
    expect(canonicalEvidenceEncode(evidence)).not.toContain('Contextual prompt body')
    expect(() => buildProviderLaunchAuthority(evidence)).not.toThrow()
  })

  it('refuses a write/readOnly contradiction', async () => {
    const binary = fakeBinary('cursor-agent-x')
    await expect(
      buildCursorSealEvidence(deps(), {
        model: 'composer-1',
        promptEnvelope: PROMPT_ENVELOPE,
        resolvedEnv: {},
        binaryPath: binary,
        workspacePath: WORKSPACE,
        writeCapable: true,
        readOnlySeat: true,
        taskWraithMcpAdvertised: false,
        cursorReasoningEffort: null,
        cursorFastMode: false,
        capabilityContract: {}
      })
    ).rejects.toThrow(/contradicts/i)
  })

  it('refuses broker intent instead of minting native-only evidence for a dynamic plan', async () => {
    const binary = fakeBinary('cursor-agent-broker-intent')
    await expect(
      buildCursorSealEvidence(deps(), {
        model: 'composer-1',
        promptEnvelope: PROMPT_ENVELOPE,
        resolvedEnv: {},
        binaryPath: binary,
        workspacePath: WORKSPACE,
        writeCapable: false,
        readOnlySeat: true,
        taskWraithMcpAdvertised: true,
        cursorReasoningEffort: null,
        cursorFastMode: false,
        capabilityContract: {}
      })
    ).rejects.toThrow(/broker-active versus native-only/i)
  })

  it('hashes the post-defusal prompt exactly as native-only dispatch sees it', async () => {
    const binary = fakeBinary('cursor-agent-prompt-defusal')
    const build = (contextualPrompt: string) =>
      buildCursorSealEvidence(deps(), {
        model: 'composer-1',
        promptEnvelope: {
          ...PROMPT_ENVELOPE,
          contextualPrompt,
          finalPrompt: 'Review the workspace.'
        },
        resolvedEnv: {},
        binaryPath: binary,
        workspacePath: WORKSPACE,
        writeCapable: false,
        readOnlySeat: true,
        taskWraithMcpAdvertised: false,
        cursorReasoningEffort: null,
        cursorFastMode: false,
        capabilityContract: {}
      })
    const staleClaim = await build(
      `${TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE}\n\nReview the workspace.`
    )
    const alreadyDefused = await build('Review the workspace.')

    expect(staleClaim.common.promptEnvelopeSha256).toBe(alreadyDefused.common.promptEnvelopeSha256)
  })
})

describe('codex seal evidence', () => {
  const policy = {
    approvalPolicyForMode: (approvalMode: string | undefined): 'never' | 'on-request' =>
      approvalMode === 'plan' ? 'never' : 'on-request',
    sandboxPolicyForMode: (approvalMode: string | undefined, workspace: string) =>
      approvalMode === 'plan'
        ? {
            type: 'readOnly' as const,
            readableRoots: [workspace],
            writableRoots: null,
            networkAccess: false
          }
        : {
            type: 'workspaceWrite' as const,
            readableRoots: null,
            writableRoots: [workspace],
            networkAccess: false
          }
  }

  it('builds canonical app-server authority and placeholds bridge/user-MCP secrets', async () => {
    const binary = fakeBinary('codex')
    const build = (bridgeToken: string, headerValue: string) => {
      const codexMcpConfig: CodexMcpTaskWraithConfig = {
        enabled: true,
        bridgeBinaryPath: '/opt/bridge',
        bridgeArgs: ['--socket', '/tmp/sock', '--token', bridgeToken],
        parentProvider: 'codex',
        userMcpServers: [
          {
            serverId: 'linear-1',
            serverName: 'linear',
            transport: 'http',
            url: 'https://mcp.linear.app/mcp',
            bearerTokenEnvVar: 'LINEAR_TOKEN',
            headers: { Authorization: headerValue }
          } as never
        ]
      }
      const processEnv = { PATH: '/usr/bin', CODEX_HOME: join(TEMP_ROOT, 'codex-home') }
      return buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        processLaunchPlan: codexProcessLaunchPlan(binary, processEnv, codexMcpConfig),
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: 'high',
        serviceTier: 'fast',
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig,
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileId: 'taskwraith-gateway-v2',
        capabilityContract: { bridgeEnabled: true },
        userMcpConfiguration: { servers: [{ name: 'linear', transport: 'http' }] },
        policy
      })
    }
    const evidence = await build('SECRET-BRIDGE-TOKEN', 'Bearer SECRET-HEADER-VALUE')
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.controls).toMatchObject({
      transport: 'app-server',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      taskWraithMcpAttachmentMode: 'app-server-config',
      persistExtendedHistory: true,
      experimentalRawEvents: false
    })
    const encoded = canonicalEvidenceEncode(evidence)
    expect(encoded).not.toContain('SECRET-BRIDGE-TOKEN')
    expect(encoded).not.toContain('SECRET-HEADER-VALUE')
    // Placeholding makes the template digests independent of the rotating
    // per-occurrence secrets while everything structural stays bound.
    const rotated = await build('DIFFERENT-TOKEN', 'Bearer DIFFERENT-HEADER')
    expect(rotated.runtime.launchArgsTemplateSha256).toBe(
      evidence.runtime.launchArgsTemplateSha256
    )
    expect(rotated.tools.providerMcpConfigurationSha256).toBe(
      evidence.tools.providerMcpConfigurationSha256
    )
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects advertisement that contradicts the app-server MCP config', async () => {
    const binary = fakeBinary('codex-2')
    await expect(
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        processLaunchPlan: codexProcessLaunchPlan(
          binary,
          { CODEX_HOME: join(TEMP_ROOT, 'codex-home') },
          null
        ),
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: null,
        serviceTier: null,
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig: null,
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileId: 'taskwraith-gateway-v2',
        capabilityContract: {},
        userMcpConfiguration: {},
        policy
      })
    ).rejects.toThrow(/does not match the app-server MCP configuration/i)
  })

  it('rejects the post-seal fast-service-tier compatibility spawn', async () => {
    const binary = fakeBinary('codex-fast-compatibility')
    const configuredPlan = codexProcessLaunchPlan(
      binary,
      { CODEX_HOME: join(TEMP_ROOT, 'codex-home') },
      null
    )
    await expect(
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        processLaunchPlan: {
          ...configuredPlan,
          startupCompatibility: 'force-fast-service-tier',
          args: ['-c', 'service_tier="fast"', 'app-server']
        },
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: null,
        serviceTier: null,
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig: null,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null,
        capabilityContract: {},
        userMcpConfiguration: {},
        policy
      })
    ).rejects.toThrow(/immutable app-server process launch plan/i)
  })

  it('rejects Codex seal evidence without an absolute private CODEX_HOME', async () => {
    const binary = fakeBinary('codex-home-required')
    await expect(
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        processLaunchPlan: codexProcessLaunchPlan(
          binary,
          { CODEX_HOME: 'relative/codex-home' },
          null
        ),
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: null,
        serviceTier: null,
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig: null,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null,
        capabilityContract: {},
        userMcpConfiguration: {},
        policy
      })
    ).rejects.toThrow(/absolute path/i)
  })

  it('rejects a symlinked protected file inside the private CODEX_HOME', async () => {
    const binary = fakeBinary('codex-home-protected-link-bin')
    const codexHome = join(TEMP_ROOT, 'codex-home-protected-link')
    const outsideConfig = join(TEMP_ROOT, 'outside-config.toml')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(outsideConfig, 'model = "gpt-5.6-terra"')
    symlinkSync(outsideConfig, join(codexHome, 'config.toml'))

    await expect(
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        processLaunchPlan: codexProcessLaunchPlan(binary, { CODEX_HOME: codexHome }, null),
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: null,
        serviceTier: null,
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig: null,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null,
        capabilityContract: {},
        userMcpConfiguration: {},
        policy
      })
    ).rejects.toThrow(/symlink.*config\.toml/i)
  })
})

describe('claude seal evidence', () => {
  it('builds canonical agent-sdk authority with the recon default permission mode', async () => {
    const sdkPackageJson = join(TEMP_ROOT, 'claude-sdk-package.json')
    writeFileSync(sdkPackageJson, JSON.stringify({ name: 'sdk', version: '0.2.141' }))
    const binary = fakeBinary('claude')
    const evidence = await buildClaudeSealEvidence(deps(), {
      model: 'default',
      promptEnvelope: PROMPT_ENVELOPE,
      session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
      resolvedEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'SECRET-ANTHROPIC-KEY' },
      binaryPath: binary,
      sdkPackageJsonPath: sdkPackageJson,
      sdkBundledCliPath: binary,
      approvalMode: 'plan',
      workflowMode: 'normal',
      effectivePermissions: readOnlyPermissions(),
      claudeReasoningEffort: 'medium',
      claudeFastMode: false,
      imageCount: 0,
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      mcpServers: {
        TaskWraith: {
          type: 'stdio',
          command: '/opt/bridge',
          args: ['--socket', '/tmp/sock.route'],
          env: { TASKWRAITH_PARENT_PROVIDER: 'claude' },
          alwaysLoad: true
        }
      },
      allowedTools: ['TaskWraith__read_file'],
      capabilityContract: { bridgeEnabled: true },
      userMcpConfiguration: { servers: [] },
      storedApiKeyConfigured: true
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.controls).toMatchObject({
      transport: 'agent-sdk',
      permissionMode: 'default',
      builtinToolMode: 'disabled',
      includePartialMessages: true,
      taskWraithMcpAttachmentMode: 'sdk-config',
      imageTransport: 'none'
    })
    expect(canonical.controls).toHaveProperty('sdkPackageSha256')
    // The resolved env is HMAC-consumed only — the API key must never appear
    // in the digestible evidence encoding.
    expect(canonicalEvidenceEncode(evidence)).not.toContain('SECRET-ANTHROPIC-KEY')
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('maps non-recon plan posture to native plan mode', async () => {
    const sdkPackageJson = join(TEMP_ROOT, 'claude-sdk-package-2.json')
    writeFileSync(sdkPackageJson, JSON.stringify({ name: 'sdk', version: '0.2.141' }))
    const binary = fakeBinary('claude-2')
    const evidence = await buildClaudeSealEvidence(deps(), {
      model: 'claude-sonnet-5',
      promptEnvelope: PROMPT_ENVELOPE,
      session: { sessionMode: 'resume', providerSessionId: 'sess-123', seatGeneration: null },
      resolvedEnv: {},
      binaryPath: null,
      sdkPackageJsonPath: sdkPackageJson,
      sdkBundledCliPath: binary,
      approvalMode: 'plan',
      workflowMode: 'plan',
      effectivePermissions: {
        ...readOnlyPermissions(),
        presetId: 'plan'
      },
      claudeReasoningEffort: null,
      claudeFastMode: null,
      imageCount: 2,
      taskWraithMcpAdvertised: false,
      taskWraithMcpProfileId: null,
      mcpServers: null,
      allowedTools: null,
      capabilityContract: {},
      userMcpConfiguration: {},
      storedApiKeyConfigured: false
    })
    expect(evidence.controls.permissionMode).toBe('plan')
    expect(evidence.controls.imageTransport).toBe('sdk-images')
    expect(evidence.common.sessionMode).toBe('resume')
    expect(evidence.common.resumeSessionHmac).toMatch(/^[0-9a-f]{64}$/)
    expect(canonicalEvidenceEncode(evidence)).not.toContain('sess-123')
    expect(() => buildProviderLaunchAuthority(evidence)).not.toThrow()
  })
})

describe('kimi seal evidence', () => {
  it('builds canonical ACP authority with the contained env projection', async () => {
    const binary = fakeBinary('kimi')
    const evidence = await buildKimiSealEvidence(deps(), {
      model: 'kimi-for-coding',
      promptEnvelope: PROMPT_ENVELOPE,
      serviceTier: 'standard',
      reasoningEffort: null,
      binaryPath: binary,
      runtimeAdmissionMode: 'unattested-development',
      requestedResumeSessionId: null,
      persistedPostureVersion: null,
      baseSpawnEnv: {
        PATH: '/usr/bin',
        HOME: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
        LANG: 'en_GB.UTF-8',
        DYLD_INSERT_LIBRARIES: '/evil/dylib',
        SECRET_TOKEN: 'SECRET-ENV-VALUE'
      },
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      capabilityContract: { admission: 'unattested-development' },
      userMcpConfiguration: {},
      appVersion: '1.8.6-test'
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.controls).toMatchObject({
      transport: 'acp',
      acpPostureVersion: 'synthetic-cwd-gateway-v1',
      workspaceCwdExposure: 'private-synthetic',
      clientFsCapability: 'none',
      taskWraithMcpAttachmentMode: 'authenticated-loopback-http-gateway',
      runtimeAdmissionMode: 'unattested-development'
    })
    expect(canonical.common.sessionMode).toBe('fresh')
    // The contained env allowlist must drop non-allowlisted and injected keys.
    const encoded = canonicalEvidenceEncode(evidence)
    expect(encoded).not.toContain('SECRET-ENV-VALUE')
    expect(encoded).not.toContain('/evil/dylib')
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('authorizes posture-matched native resume only', async () => {
    const binary = fakeBinary('kimi-2')
    const resumed = await buildKimiSealEvidence(deps(), {
      model: 'kimi-for-coding',
      promptEnvelope: PROMPT_ENVELOPE,
      serviceTier: 'fast',
      reasoningEffort: null,
      binaryPath: binary,
      runtimeAdmissionMode: 'unattested-development',
      requestedResumeSessionId: 'session_abc123',
      persistedPostureVersion: 'synthetic-cwd-gateway-v1',
      baseSpawnEnv: { PATH: '/usr/bin' },
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      capabilityContract: {},
      userMcpConfiguration: {},
      appVersion: '1.8.6-test'
    })
    expect(resumed.common.sessionMode).toBe('resume')
    expect(canonicalEvidenceEncode(resumed)).not.toContain('session_abc123')

    const legacyRejected = await buildKimiSealEvidence(deps(), {
      model: 'kimi-for-coding',
      promptEnvelope: PROMPT_ENVELOPE,
      serviceTier: 'standard',
      reasoningEffort: null,
      binaryPath: binary,
      runtimeAdmissionMode: 'unattested-development',
      requestedResumeSessionId: 'legacy-wire-id',
      persistedPostureVersion: 'synthetic-cwd-gateway-v1',
      baseSpawnEnv: { PATH: '/usr/bin' },
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      capabilityContract: {},
      userMcpConfiguration: {},
      appVersion: '1.8.6-test'
    })
    expect(legacyRejected.common.sessionMode).toBe('fresh')
    expect(legacyRejected.common.resumeSessionHmac).toBeNull()
  })
})

describe('grok seal evidence', () => {
  it('builds canonical ACP authority for a read-only scheduled seat', async () => {
    const binary = fakeBinary('grok')
    const evidence = await buildGrokSealEvidence(deps(), {
      model: 'grok-4-5',
      promptEnvelope: PROMPT_ENVELOPE,
      reasoningEffort: 'high',
      binaryPath: binary,
      resolvedEnv: { PATH: '/usr/bin' },
      approvalMode: 'plan',
      effectivePermissions: readOnlyPermissions(),
      acpEnabled: true,
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      mcpServerEntry: {
        name: 'taskwraith-scoped',
        command: '/opt/bridge',
        args: ['--socket', '/tmp/sock', '--token', 'SECRET-GROK-TOKEN'],
        env: [
          { name: 'TASKWRAITH_PARENT_PROVIDER', value: 'grok' },
          { name: 'TASKWRAITH_RUN_ID', value: 'run-1' }
        ]
      },
      capabilityContract: { acpEnabled: true },
      userMcpConfiguration: {}
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.controls).toMatchObject({
      transport: 'acp',
      permissionMode: 'host-gated',
      readOnlySeat: true,
      persistentSeatMode: 'fresh',
      webSearchEnabled: false,
      taskWraithMcpAttachmentMode: 'acp-session'
    })
    expect(canonical.common.sessionMode).toBe('fresh')
    const encoded = canonicalEvidenceEncode(evidence)
    expect(encoded).not.toContain('SECRET-GROK-TOKEN')
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails closed when the ACP transport is disabled', async () => {
    const binary = fakeBinary('grok-2')
    await expect(
      buildGrokSealEvidence(deps(), {
        model: 'grok-4-5',
        promptEnvelope: PROMPT_ENVELOPE,
        reasoningEffort: null,
        binaryPath: binary,
        resolvedEnv: {},
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        acpEnabled: false,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null,
        mcpServerEntry: null,
        capabilityContract: {},
        userMcpConfiguration: {}
      })
    ).rejects.toThrow(/no managed transport/i)
  })
})

describe('ollama seal evidence', () => {
  const fetchStub = async (url: string): Promise<unknown> => {
    if (url.endsWith('/api/version')) return { version: '0.9.9-test' }
    throw new Error(`Unexpected probe URL: ${url}`)
  }

  const launchPlan = async (
    model = 'qwen3:4b-instruct',
    advertisedToolNames = ['read_file', 'list_directory']
  ) => {
    const plan = await resolveOllamaFinalLaunchPlan(
      {
        baseUrl: 'http://127.0.0.1:11434',
        requestedModel: model,
        configuredDefaultModel: null,
        prompt: PROMPT_ENVELOPE.contextualPrompt,
        scope: 'workspace',
        workspacePath: WORKSPACE,
        toolExecutionAvailable: true,
        mcpToolsPolicy: 'ask',
        configuredNetworkAccess: 'deny',
        effectiveNetworkAccess: 'deny',
        readOnly: true,
        ollamaRunProfile: undefined,
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileId: 'taskwraith-gateway-v2',
        chatId: 'chat-ollama-seal',
        ensemble: { enabled: false }
      },
      {
        loadInstalledModels: async () => [
          {
            id: model,
            label: model,
            digest: `digest:${model}`
          }
        ],
        loadModelShow: async () => ({
          details: { family: 'qwen3', parameter_size: '32B' },
          capabilities: ['completion', 'tools']
        }),
        modelLabel: (value) => value,
        buildNativeToolDefinitions: () =>
          advertisedToolNames.map(
            (name): OllamaNativeToolDefinition => ({
              type: 'function',
              function: {
                name,
                description: `Test definition for ${name}.`,
                parameters: { type: 'object', properties: {} }
              }
            })
          ),
        getSessionMemory: () => ({
          modelId: model,
          updatedAt: 123,
          workingMemory: 'Bound scheduled memory.',
          toolTurnCount: 1,
          trajectory: []
        }),
        prepareEnsemblePrompt: ({ prompt }) => prompt,
        buildWorkspaceIndexBlock: () => 'Bound workspace index.',
        buildOpeningMessages: ({ userPrompt, workspaceIndexBlock }) => [
          { role: 'system', content: workspaceIndexBlock },
          { role: 'user', content: userPrompt }
        ],
        resolveNumCtx: () => 16_384
      }
    )
    if (!plan) throw new Error('Expected an installed Ollama launch plan.')
    return plan
  }

  it('builds canonical HTTP authority from live server evidence', async () => {
    const evidence = await buildOllamaSealEvidence(deps(), {
      launchPlan: await launchPlan(),
      model: 'qwen3:4b-instruct',
      promptEnvelope: PROMPT_ENVELOPE,
      configuredBaseUrl: 'http://127.0.0.1:11434/',
      chatRunProfileId: undefined,
      effectivePermissions: readOnlyPermissions(),
      agenticServices: { mcpTools: 'ask', networkAccess: 'deny' },
      workspaceScoped: true,
      sessionMemory: null,
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-v2',
      advertisedToolNames: ['read_file', 'list_directory'],
      capabilityContract: {},
      userMcpConfiguration: {},
      fetchJson: fetchStub
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.runtime.kind).toBe('http')
    expect(canonical.controls).toMatchObject({
      transport: 'http-chat',
      protocolMode: 'native_first',
      readOnly: true,
      networkAccess: 'deny',
      toolProtocolEnabled: true,
      nativeToolsSupported: true,
      temperature: 0.25,
      maxConsecutiveNonProductiveTurns: 4
    })
    expect(canonical.common.sessionMode).toBe('fresh')
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses legacy reconstructed facts without the production launch plan', async () => {
    await expect(
      buildOllamaSealEvidence(deps(), {
        model: 'qwen3:4b-instruct',
        promptEnvelope: PROMPT_ENVELOPE,
        configuredBaseUrl: null,
        chatRunProfileId: undefined,
        effectivePermissions: readOnlyPermissions(),
        agenticServices: { mcpTools: 'deny' },
        workspaceScoped: true,
        sessionMemory: null,
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileId: 'taskwraith-gateway-v2',
        advertisedToolNames: [],
        capabilityContract: {},
        userMcpConfiguration: {},
        fetchJson: fetchStub
      })
    ).rejects.toThrow(/exact immutable final launch plan/i)
  })

  it('binds the effective fallback temperature sent on the wire', async () => {
    const evidence = await buildOllamaSealEvidence(deps(), {
      launchPlan: await launchPlan('qwen3-coder:32b', ['read_file']),
      model: 'legacy-value-is-not-authority',
      promptEnvelope: PROMPT_ENVELOPE,
      configuredBaseUrl: null,
      chatRunProfileId: undefined,
      effectivePermissions: readOnlyPermissions(),
      agenticServices: { mcpTools: 'deny', networkAccess: 'allow' },
      workspaceScoped: false,
      sessionMemory: null,
      taskWraithMcpAdvertised: false,
      taskWraithMcpProfileId: null,
      advertisedToolNames: [],
      capabilityContract: {},
      userMcpConfiguration: { ignored: true },
      fetchJson: fetchStub
    })

    const canonical = buildProviderLaunchAuthority(evidence)
    if (canonical.provider !== 'ollama') throw new Error('Expected Ollama authority.')
    expect(canonical.common.model).toBe('qwen3-coder:32b')
    expect(canonical.controls.temperature).toBe(0.2)
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })
})
