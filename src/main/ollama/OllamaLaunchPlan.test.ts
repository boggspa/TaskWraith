import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveOllamaFinalLaunchPlan,
  resolveOllamaRequestedWireModel,
  type ResolveOllamaFinalLaunchPlanInput
} from './OllamaLaunchPlan'
import type {
  OllamaChatMessage,
  OllamaModelShowInfo,
  OllamaNativeToolDefinition
} from './OllamaProvider'

const BASE_INPUT: ResolveOllamaFinalLaunchPlanInput = {
  baseUrl: 'http://127.0.0.1:11434',
  requestedModel: 'qwen3:4b-instruct:latest',
  configuredDefaultModel: null,
  prompt: 'Inspect the workspace.',
  scope: 'workspace',
  workspacePath: '/workspace',
  toolExecutionAvailable: true,
  mcpToolsPolicy: 'ask',
  configuredNetworkAccess: 'allow',
  effectiveNetworkAccess: 'deny',
  readOnly: true,
  plan: true,
  ollamaRunProfile: 'provider_parity',
  taskWraithMcpAdvertised: true,
  taskWraithMcpProfileId: 'taskwraith-gateway-v8',
  chatId: 'chat-1',
  ensemble: {
    enabled: true,
    participantId: 'reviewer / local',
    contextChars: 12_000,
    contextTurns: 8
  }
}

const nativeDefinitions: OllamaNativeToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

function minimalLaunchDeps(modelId: string, show: OllamaModelShowInfo) {
  return {
    loadInstalledModels: async () => [{ id: modelId, label: modelId }],
    loadModelShow: async () => show,
    modelLabel: (model: string) => model,
    buildNativeToolDefinitions: () => nativeDefinitions,
    getSessionMemory: () => null,
    prepareEnsemblePrompt: ({ prompt }: { prompt: string }) => prompt,
    buildWorkspaceIndexBlock: () => '',
    buildOpeningMessages: ({ userPrompt }: { userPrompt: string }) => [
      { role: 'user' as const, content: userPrompt }
    ],
    resolveNumCtx: () => 8192
  }
}

describe('OllamaFinalLaunchPlan', () => {
  it('freezes the exact installed wire model, merged manifest, tools, keyed memory, and opening transcript', async () => {
    const getSessionMemory = vi.fn(() => ({
      modelId: 'qwen3:4b-instruct',
      updatedAt: 123,
      workingMemory: 'Already inspected package.json.',
      toolTurnCount: 2,
      trajectory: []
    }))
    const openingMessages: OllamaChatMessage[] = [
      { role: 'system', content: 'sealed system prompt' },
      { role: 'user', content: 'sealed ensemble prompt' }
    ]

    const plan = await resolveOllamaFinalLaunchPlan(BASE_INPUT, {
      loadInstalledModels: async () => [
        {
          id: 'qwen3:4b-instruct',
          label: 'Qwen 3 4B',
          digest: 'sha256:model-tag'
        }
      ],
      loadModelShow: async () => ({
        details: {
          family: 'qwen3',
          parameter_size: '4B',
          context_length: 32_768
        },
        capabilities: ['completion', 'tools']
      }),
      modelLabel: (model) => `Label: ${model}`,
      buildNativeToolDefinitions: ({
        compact,
        networkAccess,
        readOnly,
        plan,
        taskWraithMcpProfileId
      }) => {
        expect({ compact, networkAccess, readOnly, plan, taskWraithMcpProfileId }).toEqual({
          compact: true,
          networkAccess: 'deny',
          readOnly: true,
          plan: true,
          taskWraithMcpProfileId: 'taskwraith-gateway-v8'
        })
        return nativeDefinitions
      },
      getSessionMemory,
      prepareEnsemblePrompt: () => 'sealed ensemble prompt',
      buildWorkspaceIndexBlock: () => 'sealed workspace index',
      buildOpeningMessages: ({ plan, taskWraithMcpProfileId }) => {
        expect(plan).toBe(true)
        expect(taskWraithMcpProfileId).toBe('taskwraith-gateway-v8')
        return openingMessages
      },
      resolveNumCtx: () => 24_576
    })

    expect(plan).not.toBeNull()
    expect(plan).toMatchObject({
      schemaVersion: 1,
      model: 'qwen3:4b-instruct',
      modelLabel: 'Label: qwen3:4b-instruct',
      toolProtocolEnabled: true,
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-v8',
      nativeToolsSupported: true,
      compactToolSchemas: true,
      oneToolAtATime: false,
      networkAccess: 'deny',
      readOnly: true,
      plan: true,
      availableToolNames: ['read_file'],
      formatToolNames: ['read_file'],
      temperature: 0.25,
      memoryKey: 'ensemble:reviewer___local',
      promptIntent: 'workspace',
      workspaceIndexBlock: 'sealed workspace index',
      openingMessages
    })
    expect(plan?.firstRequest).toMatchObject({
      model: 'qwen3:4b-instruct',
      stream: true,
      messages: openingMessages,
      tools: nativeDefinitions,
      keep_alive: '10m',
      options: {
        temperature: 0.25,
        num_ctx: 24_576,
        num_predict: 1536
      }
    })
    expect(plan?.firstRequest).not.toHaveProperty('format')
    expect(plan?.modelManifest.merged).toMatchObject({
      id: 'qwen3:4b-instruct',
      digest: 'sha256:model-tag',
      family: 'qwen3',
      parameterSize: '4B',
      contextLength: 32_768,
      capabilities: ['completion', 'tools']
    })
    expect(getSessionMemory).toHaveBeenCalledWith('chat-1', 'ensemble:reviewer___local')
    expect(plan?.sessionMemory.workingMemory).toBe('Already inspected package.json.')
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan?.modelManifest)).toBe(true)
    expect(Object.isFrozen(plan?.nativeToolDefinitions)).toBe(true)
    expect(Object.isFrozen(plan?.sessionMemory)).toBe(true)
    expect(Object.isFrozen(plan?.openingMessages[0])).toBe(true)
  })

  it('records the effective wire fallback temperature', async () => {
    const plan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        requestedModel: 'qwen3-coder:32b',
        ensemble: { enabled: false },
        chatId: null
      },
      {
        loadInstalledModels: async () => [{ id: 'qwen3-coder:32b', label: 'Qwen Coder 32B' }],
        loadModelShow: async () => ({ capabilities: ['completion', 'tools'] }),
        modelLabel: (model) => model,
        buildNativeToolDefinitions: () => nativeDefinitions,
        getSessionMemory: () => null,
        prepareEnsemblePrompt: ({ prompt }) => prompt,
        buildWorkspaceIndexBlock: () => '',
        buildOpeningMessages: ({ userPrompt }) => [{ role: 'user', content: userPrompt }],
        resolveNumCtx: () => 8192
      }
    )

    expect(plan?.temperature).toBe(0.2)
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it('freezes direct Cloud transport and removes the local-only cloud suffix before dispatch', async () => {
    const loadModelShow = vi.fn(
      async (
        model: string,
        transport: { baseUrl: string; wireModel: string; directCloudApi: boolean }
      ) => {
        expect(model).toBe('minimax-m3:cloud')
        expect(transport).toEqual({
          baseUrl: 'https://ollama.com',
          wireModel: 'minimax-m3',
          directCloudApi: true
        })
        return { capabilities: ['completion', 'tools'] }
      }
    )
    const plan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        directCloudApiBaseUrl: 'https://ollama.com',
        requestedModel: 'minimax-m3:cloud',
        ensemble: { enabled: false }
      },
      {
        loadInstalledModels: async () => [
          { id: 'minimax-m3:cloud', label: 'MiniMax M3', source: 'cloud', isCloud: true }
        ],
        loadModelShow,
        modelLabel: () => 'MiniMax M3',
        buildNativeToolDefinitions: () => nativeDefinitions,
        getSessionMemory: () => null,
        prepareEnsemblePrompt: ({ prompt }) => prompt,
        buildWorkspaceIndexBlock: () => '',
        buildOpeningMessages: ({ userPrompt }) => [{ role: 'user', content: userPrompt }],
        resolveNumCtx: () => 8192
      }
    )

    expect(loadModelShow).toHaveBeenCalledOnce()
    expect(plan).toMatchObject({
      baseUrl: 'https://ollama.com',
      model: 'minimax-m3:cloud',
      wireModel: 'minimax-m3',
      directCloudApi: true,
      firstRequest: { model: 'minimax-m3' }
    })
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it('resolves official lightweight aliases to installed wires and preserves LFM thinking', async () => {
    expect(
      resolveOllamaRequestedWireModel('gemma3:4b', null, [
        { id: 'gemma3:latest', label: 'Gemma 3' }
      ])
    ).toBe('gemma3:latest')

    const loadModelShow = vi.fn(async (model: string) => {
      expect(model).toBe('lfm2.5-thinking:latest')
      return {
        details: {
          family: 'lfm2',
          parameter_size: '1.17B',
          context_length: 128_000
        },
        model_info: { 'general.basename': 'LFM2.5-1.2B-Thinking' },
        capabilities: ['completion', 'tools', 'thinking']
      }
    })
    const plan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        requestedModel: 'lfm2.5-thinking:1.2b',
        ensemble: { enabled: false }
      },
      {
        loadInstalledModels: async () => [
          { id: 'lfm2.5-thinking:latest', label: 'LFM 2.5 Thinking' }
        ],
        loadModelShow,
        modelLabel: (model) => model,
        buildNativeToolDefinitions: () => nativeDefinitions,
        getSessionMemory: () => null,
        prepareEnsemblePrompt: ({ prompt }) => prompt,
        buildWorkspaceIndexBlock: () => '',
        buildOpeningMessages: ({ userPrompt }) => [{ role: 'user', content: userPrompt }],
        resolveNumCtx: () => 8192
      }
    )

    expect(loadModelShow).toHaveBeenCalledWith(
      'lfm2.5-thinking:latest',
      expect.objectContaining({
        baseUrl: BASE_INPUT.baseUrl,
        wireModel: 'lfm2.5-thinking:latest',
        directCloudApi: false
      })
    )
    expect(plan).toMatchObject({
      model: 'lfm2.5-thinking:latest',
      thinkingLevel: true,
      firstRequest: {
        model: 'lfm2.5-thinking:latest',
        think: true,
        // A thinking model's first response must budget for the think stream
        // plus the tool call — the small numPredictTool budget truncates it
        // mid-thought into the degenerate-turn nudge cycle.
        options: { num_predict: 4096 }
      }
    })
  })

  it('uses authoritative show capabilities for ordinary thinking, explicit Off, and custom tags', async () => {
    const thinkingShow = { capabilities: ['completion', 'tools', 'thinking'] }
    const qwenPlan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        requestedModel: 'qwen3:4b-instruct',
        reasoningEffort: 'off',
        ensemble: { enabled: false }
      },
      {
        ...minimalLaunchDeps('qwen3:4b-instruct', thinkingShow),
        loadInstalledModels: async () => [
          {
            id: 'qwen3:4b-instruct',
            label: 'Qwen 3',
            capabilities: ['completion', 'tools']
          }
        ]
      }
    )

    expect(qwenPlan).toMatchObject({
      thinkingLevel: false,
      modelManifest: { merged: { capabilities: thinkingShow.capabilities } },
      firstRequest: {
        think: false,
        options: { num_predict: 1536 }
      }
    })

    const customPlan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        requestedModel: 'custom-thinking:latest',
        ensemble: { enabled: false }
      },
      minimalLaunchDeps('custom-thinking:latest', thinkingShow)
    )
    expect(customPlan).toMatchObject({ thinkingLevel: true, firstRequest: { think: true } })
  })

  it('honors GPT-OSS Low/Medium/High effort without exposing a false Off state', async () => {
    const plan = await resolveOllamaFinalLaunchPlan(
      {
        ...BASE_INPUT,
        requestedModel: 'gpt-oss:20b',
        reasoningEffort: 'low',
        ensemble: { enabled: false }
      },
      minimalLaunchDeps('gpt-oss:latest', {
        capabilities: ['completion', 'tools', 'thinking']
      })
    )

    expect(plan).toMatchObject({
      model: 'gpt-oss:latest',
      thinkingLevel: 'low',
      firstRequest: { think: 'low' }
    })
  })

  it('is the sole launch-fact resolver used by production dispatch', () => {
    const source = readFileSync(new URL('./OllamaProvider.ts', import.meta.url), 'utf8')
    const runSource = source.slice(source.indexOf('export async function runOllamaProvider'))

    expect(runSource).toContain('const launchPlan = await resolveOllamaFinalLaunchPlan(')
    expect(runSource).toContain('const modelInfo = launchPlan.modelManifest.merged')
    expect(runSource).toContain('JSON.stringify(launchPlan.openingMessages)')
    expect(runSource).toContain('request: turnIndex === 0 ? launchPlan.firstRequest : undefined')
    expect(runSource).not.toContain('resolveRequestedOllamaModel(')
    expect(runSource).not.toContain('resolveOllamaRunProfile(')
    expect(runSource).not.toContain('ollamaModelFamilyTemperature(')
  })
})
