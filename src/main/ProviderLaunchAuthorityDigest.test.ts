import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROVIDER_LAUNCH_CONTROL_FIELDS,
  buildProviderLaunchAuthority,
  providerLaunchAuthorityDigest,
  type ProviderLaunchAuthorityInput,
  type ProviderLaunchAuthorityInputByProvider
} from './ProviderLaunchAuthorityDigest'
import {
  antigravityLaunchAuthorityDigest,
  buildAntigravityLaunchAuthority
} from './scheduling/AntigravityLaunchAuthority'

const hex = (marker: string): string => marker.repeat(64)

const common = (model: string) => ({
  adapterRevision: 'provider-adapter-v1',
  model,
  modelCapabilitySha256: hex('9'),
  promptEnvelopeSha256: hex('a'),
  sessionMode: 'fresh' as const,
  resumeSessionHmac: null,
  providerSessionGenerationSha256: null,
  launchEnvironmentHmac: hex('b'),
  credentialStateHmac: hex('c'),
  providerConfigurationSha256: hex('0'),
  capabilityContractSha256: hex('d')
})

const tools = () => ({
  taskWraithMcpAdvertised: true,
  taskWraithMcpProfileId: 'taskwraith-full-v1' as const,
  taskWraithMcpCatalogSha256: hex('e'),
  providerMcpConfigurationSha256: hex('f'),
  userMcpConfigurationSha256: hex('1'),
  nativeToolPolicySha256: hex('2'),
  brokerPolicySha256: hex('3')
})

const cliRuntime = (provider: string) => ({
  kind: 'cli' as const,
  // resolve() keeps the path lexically canonical on every platform; the
  // validator requires `resolve(p) === p`.
  executableRealPath: resolve(`/opt/taskwraith/bin/${provider}`),
  executableSha256: hex('4'),
  runtimeBundleSha256: hex('5'),
  interpreterRuntimeAttestationSha256: hex('6'),
  executableVersion: '1.2.3',
  launchArgsTemplateSha256: hex('7')
})

const codex = {
  schemaVersion: 1,
  provider: 'codex',
  common: common('gpt-5.6-terra'),
  runtime: cliRuntime('codex'),
  tools: tools(),
  controls: {
    transport: 'app-server',
    reasoningEffort: 'high',
    reasoningConfigurationSha256: hex('6'),
    serviceTier: 'fast',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    sandboxPolicySha256: hex('7'),
    appServerConfigurationSha256: hex('8'),
    taskWraithMcpAttachmentMode: 'app-server-config',
    persistExtendedHistory: true,
    experimentalRawEvents: false,
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['codex']

const claude = {
  schemaVersion: 1,
  provider: 'claude',
  common: common('claude-sonnet-5'),
  runtime: cliRuntime('claude'),
  tools: tools(),
  controls: {
    transport: 'agent-sdk',
    reasoningEffort: 'medium',
    thinkingConfigurationSha256: hex('6'),
    fastMode: false,
    permissionMode: 'acceptEdits',
    sdkPackageSha256: hex('7'),
    builtinToolMode: 'disabled',
    includePartialMessages: true,
    taskWraithMcpAttachmentMode: 'sdk-config',
    imageTransport: 'sdk-images',
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['claude']

const kimi = {
  schemaVersion: 1,
  provider: 'kimi',
  common: common('kimi-k2.7-code'),
  runtime: cliRuntime('kimi'),
  tools: tools(),
  controls: {
    transport: 'acp',
    acpPostureVersion: 'synthetic-cwd-gateway-v1',
    workspaceCwdExposure: 'private-synthetic',
    clientFsCapability: 'none',
    taskWraithMcpAttachmentMode: 'authenticated-loopback-http-gateway',
    runtimeAdmissionRosterSha256: hex('6'),
    runtimeAdmissionMode: 'reviewed',
    thinking: false,
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['kimi']

const grok = {
  schemaVersion: 1,
  provider: 'grok',
  common: common('grok-4.5-fast'),
  runtime: cliRuntime('grok'),
  tools: tools(),
  controls: {
    transport: 'acp',
    reasoningEffort: 'high',
    permissionMode: 'host-gated',
    readOnlySeat: false,
    taskWraithMcpAttachmentMode: 'acp-session',
    persistentSeatMode: 'fresh',
    webSearchEnabled: false,
    nativeDenyRulesSha256: hex('6'),
    promptPreambleSha256: hex('7'),
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['grok']

const cursor = {
  schemaVersion: 1,
  provider: 'cursor',
  common: common('cursor-grok-4.5'),
  runtime: cliRuntime('cursor-agent'),
  tools: tools(),
  controls: {
    transport: 'cursor-agent-stream-json',
    reasoningEffort: 'medium',
    fastMode: true,
    executionMode: 'contained-default',
    bridgeMode: 'full',
    brokerRegistration: 'global',
    forceMcpTools: true,
    approveMcpServers: true,
    nativeContainmentConfigurationSha256: hex('6'),
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['cursor']

const ollama = {
  schemaVersion: 1,
  provider: 'ollama',
  common: common('qwen3.5:9b'),
  runtime: {
    kind: 'http',
    endpointHmac: hex('4'),
    serverIdentitySha256: hex('5'),
    modelManifestSha256: hex('6')
  },
  tools: tools(),
  controls: {
    transport: 'http-chat',
    reasoningLevel: true,
    contextCapTokens: 65_536,
    protocolMode: 'native_first',
    compactToolSchemas: false,
    oneToolAtATime: true,
    numPredictTool: 1536,
    numPredictFinal: 4096,
    keepAlive: '10m',
    temperature: 0.2,
    toolProtocolEnabled: true,
    nativeToolsSupported: true,
    readOnly: false,
    networkAccess: 'deny',
    harnessEnabled: true,
    maxConsecutiveNonProductiveTurns: 3,
    retryPolicySha256: hex('7'),
    memorySnapshotSha256: hex('8')
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['ollama']

const fixtures: ProviderLaunchAuthorityInput[] = [codex, claude, kimi, grok, cursor, ollama]

const piTools = {
  ...tools(),
  taskWraithMcpAdvertised: false,
  taskWraithMcpProfileId: null
} as const

const pi = {
  schemaVersion: 1,
  provider: 'pi',
  common: {
    ...common('deepseek/deepseek-chat'),
    sessionMode: 'resume',
    resumeSessionHmac: hex('4'),
    providerSessionGenerationSha256: hex('5')
  },
  runtime: cliRuntime('pi'),
  tools: piTools,
  controls: {
    transport: 'rpc',
    upstream: 'deepseek',
    modelId: 'deepseek-chat',
    thinkingMode: 'provider-default',
    writeCapable: true,
    nativeToolPolicySha256: piTools.nativeToolPolicySha256,
    providerApprovalMode: 'disabled',
    taskWraithMcpAttachmentMode: 'none',
    projectConfigurationDiscovery: 'disabled',
    isolatedHomeMode: 'per-run-mkdtemp-verified-v1',
    isolatedHomeAuthoritySha256: hex('6'),
    sessionPersistence: 'durable-per-chat',
    sessionDirectoryHmac: hex('7'),
    promptTransport: 'stdin-jsonl',
    stdinCommandTemplateSha256: hex('8'),
    shutdownPolicySha256: hex('9'),
    credentialFirewallSha256: hex('a'),
    offlineStartup: true,
    telemetryEnabled: false,
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['pi']

const antigravityTools = {
  ...tools(),
  taskWraithMcpAdvertised: false,
  taskWraithMcpProfileId: null
} as const

const antigravityAgy = {
  schemaVersion: 1,
  provider: 'antigravity',
  common: common('gemini-2.5-pro'),
  runtime: cliRuntime('agy'),
  tools: antigravityTools,
  controls: {
    transport: 'official-agy-cli',
    riskConsentAcceptedAt: 1_700_000_000_000,
    binarySource: 'path',
    binaryProvenanceState: 'verified',
    binaryProvenanceTeamId: 'EQHXZ8M8AV',
    binarySigningAuthoritySha256: hex('4'),
    binaryProvenanceDetailSha256: null,
    permissionMode: 'plan',
    sandboxed: true,
    printTimeout: '30m',
    selectedModel: 'gemini-2.5-pro',
    reasoningEffort: 'high',
    conversationMode: 'fresh',
    credentialEnvironmentPolicy: 'google-selectors-stripped',
    taskWraithMcpAttachmentMode: 'none',
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['antigravity']

const antigravityApi = {
  schemaVersion: 1,
  provider: 'antigravity',
  common: common('gemini-api:gemini-2.5-flash'),
  runtime: {
    kind: 'in-process-sdk',
    hostExecutableRealPath: resolve('/opt/taskwraith/bin/taskwraith'),
    hostExecutableSha256: hex('4'),
    hostRuntimeVersionSha256: hex('5'),
    sdkPackageJsonRealPath: resolve('/opt/taskwraith/node_modules/@google/genai/package.json'),
    sdkPackageJsonSha256: hex('6'),
    sdkEntrypointRealPath: resolve('/opt/taskwraith/node_modules/@google/genai/dist/index.js'),
    sdkEntrypointSha256: hex('7')
  },
  tools: tools(),
  controls: {
    transport: 'gemini-api-sdk',
    disclosureAcceptedAt: 1_700_000_000_100,
    apiModel: 'gemini-2.5-flash',
    apiKeyHmac: hex('8'),
    historyMode: 'host-history-replay',
    imageTransport: 'none',
    taskWraithFunctionCalling: true,
    functionDeclarationsSha256: hex('9'),
    maxToolRounds: 20,
    requestConfigurationSha256: hex('a'),
    taskWraithMcpAttachmentMode: 'in-process-function-calls',
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['antigravity']

describe('ProviderLaunchAuthorityDigest', () => {
  it('builds one strict, deeply frozen authority for every live provider', () => {
    for (const fixture of fixtures) {
      const built = buildProviderLaunchAuthority(fixture)
      expect(built.provider).toBe(fixture.provider)
      expect(Object.isFrozen(built)).toBe(true)
      expect(Object.isFrozen(built.common)).toBe(true)
      expect(Object.isFrozen(built.runtime)).toBe(true)
      expect(Object.isFrozen(built.tools)).toBe(true)
      expect(Object.isFrozen(built.controls)).toBe(true)
      expect(providerLaunchAuthorityDigest(fixture)).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('accepts every gateway generation as a distinct signed tool-surface identity', () => {
    const profileIds = [
      'taskwraith-gateway-v1',
      'taskwraith-gateway-v2',
      'taskwraith-gateway-v3',
      'taskwraith-gateway-v4',
      'taskwraith-gateway-v5',
      'taskwraith-gateway-v6',
      'taskwraith-gateway-v7',
      'taskwraith-gateway-v7-mesh',
      'taskwraith-gateway-v8',
      'taskwraith-gateway-v8-mesh',
      'taskwraith-gateway-v9',
      'taskwraith-gateway-v9-mesh',
      'taskwraith-gateway-v10',
      'taskwraith-gateway-v10-mesh',
      'taskwraith-gateway-v11',
      'taskwraith-gateway-v11-mesh',
      'taskwraith-gateway-v12',
      'taskwraith-gateway-v12-mesh',
      'taskwraith-gateway-v13',
      'taskwraith-gateway-v13-mesh',
      'taskwraith-gateway-v14',
      'taskwraith-gateway-v14-mesh',
      'taskwraith-gateway-v15',
      'taskwraith-gateway-v15-mesh',
      'taskwraith-gateway-v16',
      'taskwraith-gateway-v16-mesh',
      'taskwraith-gateway-v17',
      'taskwraith-gateway-v17-mesh',
      'taskwraith-gateway-v18',
      'taskwraith-gateway-v18-mesh',
      'taskwraith-gateway-v19',
      'taskwraith-gateway-v19-mesh',
      'taskwraith-gateway-solo-v1',
      'taskwraith-gateway-solo-v2',
      'taskwraith-gateway-solo-v3'
    ] as const
    const digests = new Set<string>()
    for (const profileId of profileIds) {
      const input = {
        ...codex,
        tools: { ...codex.tools, taskWraithMcpProfileId: profileId }
      }
      expect(buildProviderLaunchAuthority(input).tools.taskWraithMcpProfileId).toBe(profileId)
      digests.add(providerLaunchAuthorityDigest(input))
    }
    expect(digests.size).toBe(profileIds.length)
  })

  it('accepts the current gateway tool-surface identities', () => {
    for (const taskWraithMcpProfileId of [
      'taskwraith-gateway-v17',
      'taskwraith-gateway-v17-mesh',
      'taskwraith-gateway-v18',
      'taskwraith-gateway-v18-mesh',
      'taskwraith-gateway-v19',
      'taskwraith-gateway-v19-mesh',
      'taskwraith-gateway-solo-v1',
      'taskwraith-gateway-solo-v2',
      'taskwraith-gateway-solo-v3'
    ] as const) {
      const current = {
        ...codex,
        tools: { ...codex.tools, taskWraithMcpProfileId }
      }
      expect(buildProviderLaunchAuthority(current).tools.taskWraithMcpProfileId).toBe(
        taskWraithMcpProfileId
      )
    }
  })

  it('accepts inactive full-v3 as a distinct signed profile identity without selecting it', () => {
    const input = {
      ...codex,
      tools: { ...codex.tools, taskWraithMcpProfileId: 'taskwraith-full-v3' as const }
    }
    expect(buildProviderLaunchAuthority(input).tools.taskWraithMcpProfileId).toBe(
      'taskwraith-full-v3'
    )
    expect(providerLaunchAuthorityDigest(input)).not.toBe(providerLaunchAuthorityDigest(codex))
  })

  it('is deterministic across object insertion order', () => {
    const reordered = {
      controls: { ...codex.controls },
      tools: { ...codex.tools },
      runtime: { ...codex.runtime },
      common: {
        capabilityContractSha256: codex.common.capabilityContractSha256,
        providerConfigurationSha256: codex.common.providerConfigurationSha256,
        credentialStateHmac: codex.common.credentialStateHmac,
        launchEnvironmentHmac: codex.common.launchEnvironmentHmac,
        providerSessionGenerationSha256: codex.common.providerSessionGenerationSha256,
        resumeSessionHmac: codex.common.resumeSessionHmac,
        sessionMode: codex.common.sessionMode,
        promptEnvelopeSha256: codex.common.promptEnvelopeSha256,
        modelCapabilitySha256: codex.common.modelCapabilitySha256,
        model: codex.common.model,
        adapterRevision: codex.common.adapterRevision
      },
      provider: 'codex',
      schemaVersion: 1
    } as const satisfies ProviderLaunchAuthorityInputByProvider['codex']
    expect(providerLaunchAuthorityDigest(reordered)).toBe(providerLaunchAuthorityDigest(codex))
  })

  it('binds common, runtime, tool-surface, and provider-specific mutable controls', () => {
    const base = providerLaunchAuthorityDigest(codex)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        common: { ...codex.common, adapterRevision: 'provider-adapter-v2' }
      })
    ).not.toBe(base)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        runtime: { ...codex.runtime, executableSha256: hex('9') }
      })
    ).not.toBe(base)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        runtime: { ...codex.runtime, runtimeBundleSha256: hex('9') }
      })
    ).not.toBe(base)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        runtime: { ...codex.runtime, interpreterRuntimeAttestationSha256: hex('9') }
      })
    ).not.toBe(base)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        tools: { ...codex.tools, nativeToolPolicySha256: hex('9') }
      })
    ).not.toBe(base)
    expect(
      providerLaunchAuthorityDigest({
        ...codex,
        controls: { ...codex.controls, serviceTier: 'standard' }
      })
    ).not.toBe(base)

    expect(
      providerLaunchAuthorityDigest({
        ...claude,
        controls: { ...claude.controls, fastMode: true }
      })
    ).not.toBe(providerLaunchAuthorityDigest(claude))
    expect(
      providerLaunchAuthorityDigest({
        ...kimi,
        controls: { ...kimi.controls, thinking: true }
      })
    ).not.toBe(providerLaunchAuthorityDigest(kimi))
    expect(
      providerLaunchAuthorityDigest({
        ...grok,
        controls: { ...grok.controls, webSearchEnabled: true }
      })
    ).not.toBe(providerLaunchAuthorityDigest(grok))
    expect(
      providerLaunchAuthorityDigest({
        ...cursor,
        controls: { ...cursor.controls, fastMode: false }
      })
    ).not.toBe(providerLaunchAuthorityDigest(cursor))
    expect(
      providerLaunchAuthorityDigest({
        ...ollama,
        controls: { ...ollama.controls, contextCapTokens: 32_768 }
      })
    ).not.toBe(providerLaunchAuthorityDigest(ollama))
    expect(
      providerLaunchAuthorityDigest({
        ...ollama,
        controls: { ...ollama.controls, reasoningLevel: false }
      })
    ).not.toBe(providerLaunchAuthorityDigest(ollama))
  })

  it('rejects Gemini, unknown fields, missing fields, and malformed digests', () => {
    expect(() => buildProviderLaunchAuthority({ ...codex, provider: 'gemini' } as never)).toThrow(
      /Gemini is retired/i
    )
    expect(() => buildProviderLaunchAuthority({ ...codex, extra: true } as never)).toThrow(
      /invalid field set/i
    )
    const missing = { ...codex.controls } as Record<string, unknown>
    delete missing.sandboxPolicySha256
    expect(() => buildProviderLaunchAuthority({ ...codex, controls: missing } as never)).toThrow(
      /invalid field set/i
    )
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        common: { ...codex.common, credentialStateHmac: 'plaintext-secret' }
      } as never)
    ).toThrow(/canonical SHA-256\/HMAC/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        common: { ...codex.common, credentialStateHmac: null }
      } as never)
    ).toThrow(/credential state HMAC/i)
  })

  it('rejects rather than silently trimming launch-affecting text and paths', () => {
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        common: { ...codex.common, model: ` ${codex.common.model}` }
      } as never)
    ).toThrow(/provider model is invalid/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        // The trailing space keeps this path deliberately invalid on every platform.
        runtime: { ...codex.runtime, executableRealPath: `${codex.runtime.executableRealPath} ` }
      } as never)
    ).toThrow(/executable real path is invalid/i)
  })

  it('keeps raw credentials and endpoints outside the canonical authority', () => {
    const secret = 'sk-dangerously-plaintext'
    const built = buildProviderLaunchAuthority(codex)
    const serialized = JSON.stringify(built)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('ANTHROPIC_API_KEY')
    expect(serialized).not.toContain('http://user:password@localhost:11434')
    expect(() =>
      buildProviderLaunchAuthority({
        ...ollama,
        runtime: {
          ...ollama.runtime,
          endpointHmac: 'http://user:password@localhost:11434'
        }
      } as never)
    ).toThrow(/endpoint HMAC/i)
  })

  it('enforces provider transport/tool invariants', () => {
    expect(() =>
      buildProviderLaunchAuthority({
        ...claude,
        controls: { ...claude.controls, transport: 'cli-print', sdkPackageSha256: hex('7') }
      } as never)
    ).toThrow(/SDK package identity/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...kimi,
        tools: { ...kimi.tools, taskWraithMcpAdvertised: false, taskWraithMcpProfileId: null }
      } as never)
    ).toThrow(/gateway advertised/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...kimi,
        controls: { ...kimi.controls, transport: 'wire' }
      } as never)
    ).toThrow(/Kimi transport/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...grok,
        common: {
          ...grok.common,
          sessionMode: 'reusable',
          resumeSessionHmac: hex('9'),
          providerSessionGenerationSha256: hex('0')
        },
        controls: { ...grok.controls, persistentSeatMode: 'read-only-toolless-reuse' }
      } as never)
    ).toThrow(/read-only, tool-less ACP/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...cursor,
        controls: { ...cursor.controls, bridgeMode: 'none' }
      } as never)
    ).toThrow(/advertisement must match bridge/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...ollama,
        controls: { ...ollama.controls, toolProtocolEnabled: false }
      } as never)
    ).toThrow(/advertisement must match its tool protocol/i)
  })

  it('binds fresh, resumed, and host-reusable session authority without ambiguous nulls', () => {
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        common: { ...codex.common, resumeSessionHmac: hex('9') }
      } as never)
    ).toThrow(/Fresh provider sessions cannot carry/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        common: { ...codex.common, sessionMode: 'resume', resumeSessionHmac: hex('9') }
      } as never)
    ).toThrow(/require identity and generation/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...claude,
        common: {
          ...claude.common,
          sessionMode: 'reusable',
          resumeSessionHmac: hex('9'),
          providerSessionGenerationSha256: hex('0')
        }
      } as never)
    ).toThrow(/Only a host-owned Grok seat/i)

    const resumedCodex = {
      ...codex,
      common: {
        ...codex.common,
        sessionMode: 'resume',
        resumeSessionHmac: hex('9'),
        providerSessionGenerationSha256: hex('0')
      }
    } as const satisfies ProviderLaunchAuthorityInputByProvider['codex']
    expect(buildProviderLaunchAuthority(resumedCodex).common.sessionMode).toBe('resume')

    const reusableGrok = {
      ...grok,
      common: {
        ...grok.common,
        sessionMode: 'reusable',
        resumeSessionHmac: hex('9'),
        providerSessionGenerationSha256: hex('0')
      },
      tools: {
        ...grok.tools,
        taskWraithMcpAdvertised: false,
        taskWraithMcpProfileId: null
      },
      controls: {
        ...grok.controls,
        readOnlySeat: true,
        taskWraithMcpAttachmentMode: 'none',
        persistentSeatMode: 'read-only-toolless-reuse'
      }
    } as const satisfies ProviderLaunchAuthorityInputByProvider['grok']
    expect(buildProviderLaunchAuthority(reusableGrok).common.sessionMode).toBe('reusable')
  })

  it('rejects provider tool-surface and attachment/bridge contradictions', () => {
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        controls: { ...codex.controls, taskWraithMcpAttachmentMode: 'none' }
      } as never)
    ).toThrow(/Codex TaskWraith MCP advertisement must match/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...claude,
        controls: { ...claude.controls, taskWraithMcpAttachmentMode: 'none' }
      } as never)
    ).toThrow(/Claude TaskWraith MCP advertisement must match/i)
    // A detached Kimi gateway is structurally unrepresentable, not merely
    // contradictory: the ACP attachment mode has no 'none' member.
    expect(() =>
      buildProviderLaunchAuthority({
        ...kimi,
        controls: { ...kimi.controls, taskWraithMcpAttachmentMode: 'none' }
      } as never)
    ).toThrow(/Kimi TaskWraith MCP attachment mode is invalid/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...grok,
        controls: { ...grok.controls, taskWraithMcpAttachmentMode: 'none' }
      } as never)
    ).toThrow(/Grok TaskWraith MCP advertisement must match/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...cursor,
        controls: { ...cursor.controls, bridgeMode: 'none' }
      } as never)
    ).toThrow(/Cursor TaskWraith MCP advertisement must match/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...ollama,
        controls: { ...ollama.controls, toolProtocolEnabled: false }
      } as never)
    ).toThrow(/Ollama TaskWraith MCP advertisement must match/i)
  })

  it('accepts only dispatcher-enforced no-fallback authority', () => {
    expect(() =>
      buildProviderLaunchAuthority({
        ...codex,
        controls: { ...codex.controls, fallbackPolicy: 'exec-if-preflight-allows' }
      } as never)
    ).toThrow(/Codex fallback policy is invalid/i)
  })

  it('centrally normalizes Pi and both conditional AntiGravity transports', () => {
    for (const fixture of [pi, antigravityAgy, antigravityApi] as const) {
      const built = buildProviderLaunchAuthority(fixture)
      expect(built.provider).toBe(fixture.provider)
      expect(Object.isFrozen(built)).toBe(true)
      expect(Object.isFrozen(built.runtime)).toBe(true)
      expect(Object.isFrozen(built.controls)).toBe(true)
      expect(providerLaunchAuthorityDigest(fixture)).toMatch(/^[a-f0-9]{64}$/)
    }

    expect(providerLaunchAuthorityDigest(antigravityAgy)).toBe(
      antigravityLaunchAuthorityDigest(antigravityAgy)
    )
    expect(providerLaunchAuthorityDigest(antigravityApi)).toBe(
      antigravityLaunchAuthorityDigest(antigravityApi)
    )
  })

  it('binds Pi and AntiGravity provider-local controls and rejects provider swaps', () => {
    expect(
      providerLaunchAuthorityDigest({
        ...pi,
        controls: { ...pi.controls, writeCapable: false }
      })
    ).not.toBe(providerLaunchAuthorityDigest(pi))
    expect(
      providerLaunchAuthorityDigest({
        ...antigravityApi,
        controls: { ...antigravityApi.controls, apiKeyHmac: hex('f') }
      })
    ).not.toBe(providerLaunchAuthorityDigest(antigravityApi))

    expect(() =>
      buildProviderLaunchAuthority({
        ...pi,
        common: { ...pi.common, model: 'deepseek/different-model' }
      })
    ).toThrow(/exactly match.*upstream\/model/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...pi,
        common: { ...pi.common, model: 'qwen-token-plan/kimi-k2.5' },
        controls: {
          ...pi.controls,
          upstream: 'qwen-token-plan',
          modelId: 'kimi-k2.5'
        }
      })
    ).toThrow(/resold copy|production policy/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...antigravityAgy,
        controls: { ...antigravityAgy.controls, selectedModel: 'different-model' }
      })
    ).toThrow(/selected model.*production normalization/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...antigravityAgy,
        controls: {
          ...antigravityAgy.controls,
          binaryProvenanceTeamId: null,
          binarySigningAuthoritySha256: null
        }
      })
    ).toThrow(/Verified agy provenance/i)
    expect(() =>
      buildProviderLaunchAuthority({
        ...antigravityAgy,
        controls: {
          ...antigravityAgy.controls,
          binaryProvenanceState: 'unverified',
          binaryProvenanceTeamId: null,
          binarySigningAuthoritySha256: null,
          binaryProvenanceDetailSha256: null
        }
      })
    ).toThrow(/Unverified agy provenance/i)

    const defaultAgy = {
      ...antigravityAgy,
      common: { ...antigravityAgy.common, model: 'cli-default' },
      controls: { ...antigravityAgy.controls, selectedModel: null }
    } as const satisfies ProviderLaunchAuthorityInputByProvider['antigravity']
    expect(() => buildProviderLaunchAuthority(defaultAgy)).not.toThrow()

    expect(() => buildProviderLaunchAuthority({ ...pi, provider: 'antigravity' } as never)).toThrow(
      /AntiGravity|transport/i
    )
    expect(() =>
      buildProviderLaunchAuthority({ ...antigravityAgy, provider: 'pi' } as never)
    ).toThrow(/Pi controls|invalid field set/i)
  })

  it('rejects AntiGravity symbol, accessor, whitespace, and NUL smuggling locally', () => {
    const symbolControls = { ...antigravityAgy.controls } as Record<PropertyKey, unknown>
    symbolControls[Symbol('hidden')] = true
    expect(() =>
      buildAntigravityLaunchAuthority({
        ...antigravityAgy,
        controls: symbolControls
      } as never)
    ).toThrow(/symbol fields/i)

    const accessorControls = { ...antigravityAgy.controls } as Record<string, unknown>
    Object.defineProperty(accessorControls, 'selectedModel', {
      enumerable: true,
      configurable: true,
      get: () => antigravityAgy.controls.selectedModel
    })
    expect(() =>
      buildAntigravityLaunchAuthority({
        ...antigravityAgy,
        controls: accessorControls
      } as never)
    ).toThrow(/accessor/i)

    expect(() =>
      buildAntigravityLaunchAuthority({
        ...antigravityAgy,
        common: { ...antigravityAgy.common, model: ` ${antigravityAgy.common.model}` }
      } as never)
    ).toThrow(/model must be non-empty bounded text/i)
    expect(() =>
      buildAntigravityLaunchAuthority({
        ...antigravityAgy,
        controls: { ...antigravityAgy.controls, printTimeout: '30m\0hidden' }
      } as never)
    ).toThrow(/print timeout must be non-empty bounded text/i)
  })

  it('keeps runtime field policies aligned with every provider control schema', () => {
    for (const fixture of fixtures) {
      expect(Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS[fixture.provider]).sort()).toEqual(
        Object.keys(fixture.controls).sort()
      )
    }
  })
})
