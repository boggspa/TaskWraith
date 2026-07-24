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
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import type { AppSettings, EffectiveRunPermissions } from '../store/types'
import {
  SealEvidenceFileHasher,
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  canonicalEvidenceEncode
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
      cursorReasoningEffort: null,
      cursorFastMode: false,
      capabilityContract: { gates: { sandbox: 'enabled' } },
      userMcpConfiguration: { servers: [] }
    })
    const canonical = buildProviderLaunchAuthority(evidence)
    expect(canonical.provider).toBe('cursor')
    expect(canonical.controls).toMatchObject({
      executionMode: 'plan',
      bridgeMode: 'none',
      brokerRegistration: 'none',
      forceMcpTools: false,
      approveMcpServers: false
    })
    expect(canonical.tools.taskWraithMcpAdvertised).toBe(false)
    expect(canonical.common.sessionMode).toBe('fresh')
    expect(canonical.runtime.kind).toBe('cli')
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
        cursorReasoningEffort: 'medium',
        cursorFastMode: true,
        capabilityContract: {},
        userMcpConfiguration: { servers: [] }
      })
    const evidence = await build('Contextual prompt body one.')
    const otherPrompt = await build('A completely different prompt.')
    expect(evidence.controls.executionMode).toBe('contained-default')
    // The argv template excludes prompt bytes: different prompts, same
    // template digest — while the prompt envelope digest DOES change.
    expect(otherPrompt.runtime.launchArgsTemplateSha256).toBe(
      evidence.runtime.launchArgsTemplateSha256
    )
    expect(otherPrompt.common.promptEnvelopeSha256).not.toBe(
      evidence.common.promptEnvelopeSha256
    )
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
        cursorReasoningEffort: null,
        cursorFastMode: false,
        capabilityContract: {},
        userMcpConfiguration: {}
      })
    ).rejects.toThrow(/contradicts/i)
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
    const build = (bridgeToken: string, headerValue: string) =>
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        resolvedEnv: { PATH: '/usr/bin', CODEX_HOME: join(TEMP_ROOT, 'codex-home') },
        binaryPath: binary,
        workspacePath: WORKSPACE,
        approvalMode: 'plan',
        effectivePermissions: readOnlyPermissions(),
        reasoningEffort: 'high',
        serviceTier: 'fast',
        settings: { agenticServices: {} } as unknown as AppSettings,
        codexMcpConfig: {
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
        },
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileId: 'taskwraith-gateway-v2',
        capabilityContract: { bridgeEnabled: true },
        userMcpConfiguration: { servers: [{ name: 'linear', transport: 'http' }] },
        policy
      })
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
        resolvedEnv: { CODEX_HOME: join(TEMP_ROOT, 'codex-home') },
        binaryPath: binary,
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

  it('rejects Codex seal evidence without an absolute private CODEX_HOME', async () => {
    const binary = fakeBinary('codex-home-required')
    await expect(
      buildCodexSealEvidence(deps(), {
        model: 'gpt-5.6-terra',
        promptEnvelope: PROMPT_ENVELOPE,
        session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
        resolvedEnv: { CODEX_HOME: 'relative/codex-home' },
        binaryPath: binary,
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
        resolvedEnv: { CODEX_HOME: codexHome },
        binaryPath: binary,
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
    if (url.endsWith('/api/show')) {
      return {
        details: { family: 'qwen3', parameter_size: '32B' },
        capabilities: ['completion', 'tools']
      }
    }
    throw new Error(`Unexpected probe URL: ${url}`)
  }

  it('builds canonical HTTP authority from live server evidence', async () => {
    const evidence = await buildOllamaSealEvidence(deps(), {
      model: 'qwen3-coder:32b',
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
      temperature: 0.2,
      maxConsecutiveNonProductiveTurns: 4
    })
    expect(canonical.common.sessionMode).toBe('fresh')
    expect(providerLaunchAuthorityDigest(evidence)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses advertisement without a live tool protocol', async () => {
    await expect(
      buildOllamaSealEvidence(deps(), {
        model: 'qwen3-coder:32b',
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
    ).rejects.toThrow(/does not match its tool protocol availability/i)
  })
})
