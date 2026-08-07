import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEffectiveRuntimeLaunchAuthority,
  type EffectiveRuntimeLaunchAuthorityInput
} from './ScheduledOccurrenceSeal'
import {
  providerLaunchAuthorityDigest,
  type ProviderLaunchAuthorityInputByProvider
} from './ProviderLaunchAuthorityDigest'

const hex = (marker: string): string => marker.repeat(64)

const services = {
  shellCommands: 'deny',
  fileChanges: 'deny',
  externalPublish: 'deny',
  mcpTools: 'deny',
  subThreadDelegation: 'deny',
  canvasInteraction: 'deny',
  sketchCanvas: 'deny',
  meshCanvas: 'deny',
  simulatorCanvas: 'deny',
  canvasEval: 'deny',
  crossThreadRead: 'deny',
  threadMessage: 'deny',
  mediaEditing: 'deny',
  mediaRecording: 'deny',
  webBrowsing: 'deny'
} as const

const common = (model: string) => ({
  adapterRevision: 'provider-adapter-v1',
  model,
  modelCapabilitySha256: hex('1'),
  promptEnvelopeSha256: hex('2'),
  sessionMode: 'fresh' as const,
  resumeSessionHmac: null,
  providerSessionGenerationSha256: null,
  launchEnvironmentHmac: hex('3'),
  credentialStateHmac: hex('4'),
  providerConfigurationSha256: hex('5'),
  capabilityContractSha256: hex('6')
})

const noTools = {
  taskWraithMcpAdvertised: false,
  taskWraithMcpProfileId: null,
  taskWraithMcpCatalogSha256: hex('7'),
  providerMcpConfigurationSha256: hex('8'),
  userMcpConfigurationSha256: hex('9'),
  nativeToolPolicySha256: hex('a'),
  brokerPolicySha256: hex('b')
} as const

const cliRuntime = (name: string) => ({
  kind: 'cli' as const,
  executableRealPath: resolve(`/opt/taskwraith/bin/${name}`),
  executableSha256: hex('c'),
  runtimeBundleSha256: hex('d'),
  interpreterRuntimeAttestationSha256: hex('e'),
  executableVersion: '1.0.0',
  launchArgsTemplateSha256: hex('f')
})

const pi = {
  schemaVersion: 1,
  provider: 'pi',
  common: {
    ...common('deepseek/deepseek-chat'),
    sessionMode: 'resume',
    resumeSessionHmac: hex('1'),
    providerSessionGenerationSha256: hex('2')
  },
  runtime: cliRuntime('pi'),
  tools: noTools,
  controls: {
    transport: 'rpc',
    upstream: 'deepseek',
    modelId: 'deepseek-chat',
    thinkingMode: 'provider-default',
    writeCapable: true,
    nativeToolPolicySha256: noTools.nativeToolPolicySha256,
    providerApprovalMode: 'disabled',
    taskWraithMcpAttachmentMode: 'none',
    projectConfigurationDiscovery: 'disabled',
    isolatedHomeMode: 'per-run-mkdtemp-verified-v1',
    isolatedHomeAuthoritySha256: hex('3'),
    sessionPersistence: 'durable-per-chat',
    sessionDirectoryHmac: hex('4'),
    promptTransport: 'stdin-jsonl',
    stdinCommandTemplateSha256: hex('5'),
    shutdownPolicySha256: hex('6'),
    credentialFirewallSha256: hex('7'),
    offlineStartup: true,
    telemetryEnabled: false,
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['pi']

const antigravityAgy = {
  schemaVersion: 1,
  provider: 'antigravity',
  common: common('gemini-2.5-pro'),
  runtime: cliRuntime('agy'),
  tools: noTools,
  controls: {
    transport: 'official-agy-cli',
    riskConsentAcceptedAt: 1_700_000_000_000,
    binarySource: 'path',
    binaryProvenanceState: 'verified',
    binaryProvenanceTeamId: 'EQHXZ8M8AV',
    binarySigningAuthoritySha256: hex('8'),
    binaryProvenanceDetailSha256: null,
    permissionMode: 'plan',
    sandboxed: true,
    printTimeout: '30m',
    selectedModel: 'gemini-2.5-pro',
    reasoningEffort: null,
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
    hostExecutableSha256: hex('1'),
    hostRuntimeVersionSha256: hex('2'),
    sdkPackageJsonRealPath: resolve('/opt/taskwraith/node_modules/@google/genai/package.json'),
    sdkPackageJsonSha256: hex('3'),
    sdkEntrypointRealPath: resolve('/opt/taskwraith/node_modules/@google/genai/dist/index.js'),
    sdkEntrypointSha256: hex('4')
  },
  tools: noTools,
  controls: {
    transport: 'gemini-api-sdk',
    disclosureAcceptedAt: 1_700_000_000_100,
    apiModel: 'gemini-2.5-flash',
    apiKeyHmac: hex('5'),
    historyMode: 'host-history-replay',
    imageTransport: 'none',
    taskWraithFunctionCalling: false,
    functionDeclarationsSha256: hex('6'),
    maxToolRounds: 20,
    requestConfigurationSha256: hex('7'),
    taskWraithMcpAttachmentMode: 'none',
    fallbackPolicy: 'forbid'
  }
} as const satisfies ProviderLaunchAuthorityInputByProvider['antigravity']

function effective(
  providerLaunchAuthority:
    | ProviderLaunchAuthorityInputByProvider['pi']
    | ProviderLaunchAuthorityInputByProvider['antigravity'],
  effectiveBinary: string
): EffectiveRuntimeLaunchAuthorityInput {
  return {
    schemaVersion: 1,
    provider: providerLaunchAuthority.provider,
    effectiveBinary,
    effectiveWorkspaceMode: 'local',
    effectiveMcpProfileId: null,
    effectiveApprovalMode: providerLaunchAuthority.provider === 'pi' ? 'default' : 'plan',
    effectiveAgenticServices: services,
    effectiveNetworkPolicy: 'deny',
    effectivePersistence:
      providerLaunchAuthority.provider === 'antigravity' &&
      providerLaunchAuthority.runtime.kind === 'in-process-sdk'
        ? 'reusable'
        : 'ephemeral',
    providerLaunchAuthority
  }
}

describe('scheduled occurrence authority for producer-only providers', () => {
  it('accepts Pi and official agy CLI executable identities', () => {
    for (const authority of [pi, antigravityAgy] as const) {
      const built = buildEffectiveRuntimeLaunchAuthority(
        effective(authority, authority.runtime.executableRealPath)
      )
      expect(built.provider).toBe(authority.provider)
      expect(built.providerLaunchAuthorityDigest).toBe(providerLaunchAuthorityDigest(authority))
    }
  })

  it('accepts the conditional AntiGravity in-process SDK host executable', () => {
    const built = buildEffectiveRuntimeLaunchAuthority(
      effective(antigravityApi, antigravityApi.runtime.hostExecutableRealPath)
    )
    expect(built.provider).toBe('antigravity')
    expect(built.effectiveBinary).toBe(antigravityApi.runtime.hostExecutableRealPath)

    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effective(antigravityApi, antigravityApi.runtime.hostExecutableRealPath),
        effectivePersistence: 'ephemeral'
      })
    ).toThrow(/reusable host persistence/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority(
        effective(antigravityApi, resolve('/opt/taskwraith/bin/different-host'))
      )
    ).toThrow(/SDK host executable/i)
  })

  it('rejects provider identity swaps before minting effective authority', () => {
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effective(antigravityAgy, antigravityAgy.runtime.executableRealPath),
        provider: 'pi'
      })
    ).toThrow(/does not match/i)
    expect(() =>
      buildEffectiveRuntimeLaunchAuthority({
        ...effective(pi, pi.runtime.executableRealPath),
        provider: 'antigravity'
      })
    ).toThrow(/does not match/i)
  })
})
