import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROVIDER_LAUNCH_CONTROL_FIELDS,
  buildProviderLaunchAuthority,
  providerLaunchAuthorityDigest,
  type ProviderLaunchAuthorityInput,
  type ProviderLaunchAuthorityInputByProvider
} from './ProviderLaunchAuthorityDigest'

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
    reasoningLevel: 'medium',
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

  it('accepts gateway-v2 as a distinct signed tool-surface identity', () => {
    const gatewayV2 = {
      ...codex,
      tools: { ...codex.tools, taskWraithMcpProfileId: 'taskwraith-gateway-v2' as const }
    }
    expect(buildProviderLaunchAuthority(gatewayV2).tools.taskWraithMcpProfileId).toBe(
      'taskwraith-gateway-v2'
    )
    expect(providerLaunchAuthorityDigest(gatewayV2)).not.toBe(providerLaunchAuthorityDigest(codex))
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

  it('keeps runtime field policies aligned with every provider control schema', () => {
    for (const fixture of fixtures) {
      expect(Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS[fixture.provider]).sort()).toEqual(
        Object.keys(fixture.controls).sort()
      )
    }
  })
})
