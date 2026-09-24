import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyBridgeToolResultIdentity,
  bridgeAssistantMessageMetadata,
  bridgeModelMetadataFromEvent,
  bridgeToolRowMetadata,
  buildBridgeToolActivity
} from './BridgeTranscriptActivity'

describe('bridgeToolRowMetadata', () => {
  // A bridge-lane tool row carried no metadata at all, so its accent depended
  // entirely on finding its run in the chat record — and that array is empty on
  // a paged/summary record and one render stale on a retained one. Stamping the
  // row makes it self-branding, exactly like the solo lane's reducer does.
  it('prefers the provider-reported wire id', () => {
    expect(
      bridgeToolRowMetadata({
        actualModel: 'qwen3.5:9b',
        modelLabel: 'Qwen 3.5 (9B Param)',
        run: { runId: 'run-1', requestedModel: 'qwen3.5:9b-stale' }
      })
    ).toEqual({
      providerModel: 'qwen3.5:9b',
      providerModelLabel: 'Qwen 3.5 (9B Param)'
    })
  })

  it('falls back to the run requested model, which is the only Pi wire id there is', () => {
    // Pi deliberately leaves `actualModel` UNSET (0f1347266: its terminal event
    // reports the human label, and treating that as a wire id was cause 1 of
    // this very investigation). The label alone cannot brand a Pi upstream —
    // `resolvePiUpstreamBrand` splits a `<upstream>/<model>` wire id — so
    // without the run's requestedModel this stamp would be useless for the one
    // seat that most needs it.
    expect(
      bridgeToolRowMetadata({
        modelLabel: 'Qwen 3.8 27B (Cerebras)',
        run: { runId: 'run-1', requestedModel: 'cerebras/qwen-3.8-27b' }
      })
    ).toEqual({
      providerModel: 'cerebras/qwen-3.8-27b',
      providerModelLabel: 'Qwen 3.8 27B (Cerebras)'
    })
  })

  it('takes the run actual model ahead of its requested model', () => {
    expect(
      bridgeToolRowMetadata({
        run: { runId: 'run-1', actualModel: 'gpt-5.6-sol', requestedModel: 'gpt-5.3-codex-spark' }
      })
    ).toEqual({ providerModel: 'gpt-5.6-sol' })
  })

  it('returns undefined when no model is known anywhere', () => {
    // A row that gained an empty metadata object would read as "has metadata"
    // to anything inspecting it, and the pre-stamp shape was no metadata key.
    expect(bridgeToolRowMetadata({})).toBeUndefined()
    expect(bridgeToolRowMetadata({ run: { runId: 'run-1' } })).toBeUndefined()
  })

  it('never claims to be an assistant turn and never tags a card kind', () => {
    // `assistantProvider` makes a row claim an assistant turn; `kind` is the
    // transcript-card discriminator. Neither belongs on a burst row.
    const metadata = bridgeToolRowMetadata({
      actualModel: 'kimi-k3',
      modelLabel: 'Kimi K3',
      run: { runId: 'run-1' }
    })
    expect(metadata).toBeDefined()
    expect(Object.keys(metadata as object).sort()).toEqual(['providerModel', 'providerModelLabel'])
  })
})

describe('flushBridgeRunTranscript tool-row wiring', () => {
  // The call site lives in the index.ts monolith where no unit test reaches it.
  // Source-string guard, the same idiom GoalFirstTurnIntegration uses.
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

  it('stamps the tool part with the resolved row metadata', () => {
    expect(indexSource).toContain('bridgeToolRowMetadata(')
    // The tool branch of the part message must actually spread it, not merely
    // compute it — this is the line that reaches the transcript.
    expect(indexSource).toContain('...(toolRowMetadata ? { metadata: toolRowMetadata } : {})')
  })
})

describe('BridgeTranscriptActivity', () => {
  it('freezes the bridge assistant provider and model identity', () => {
    const metadata = bridgeModelMetadataFromEvent({
      type: 'content',
      model: 'qwen3.5:9b',
      modelLabel: 'Qwen 3.5 (9B Param)'
    })

    expect(metadata).toEqual({
      model: 'qwen3.5:9b',
      modelLabel: 'Qwen 3.5 (9B Param)'
    })
    expect(
      bridgeAssistantMessageMetadata({
        provider: 'ollama',
        actualModel: metadata.model,
        modelLabel: metadata.modelLabel
      })
    ).toEqual({
      assistantProvider: 'ollama',
      providerModel: 'qwen3.5:9b',
      providerModelLabel: 'Qwen 3.5 (9B Param)'
    })
  })

  it('treats a Pi terminal label as modelLabel without clobbering the wire model id', () => {
    const metadata = bridgeModelMetadataFromEvent({
      type: 'result',
      status: 'success',
      modelLabel: 'DeepSeek V4 Pro'
    })

    expect(metadata).toEqual({ modelLabel: 'DeepSeek V4 Pro' })
    expect(
      bridgeAssistantMessageMetadata({
        provider: 'pi',
        actualModel: metadata.model,
        modelLabel: metadata.modelLabel
      })
    ).toEqual({
      assistantProvider: 'pi',
      providerModelLabel: 'DeepSeek V4 Pro'
    })
  })

  it('stamps non-Ollama bridge assistant provider and model metadata too', () => {
    expect(
      bridgeAssistantMessageMetadata({
        provider: 'codex',
        actualModel: 'gpt-5.5',
        modelLabel: 'GPT-5.5'
      })
    ).toEqual({
      assistantProvider: 'codex',
      providerModel: 'gpt-5.5',
      providerModelLabel: 'GPT-5.5'
    })
  })

  it('builds bridge tool activities with provider attribution and tool_kind category parity', () => {
    const activity = buildBridgeToolActivity({
      provider: 'grok',
      activityIndex: 0,
      nowIso: () => '2026-06-13T00:00:00.000Z',
      payload: {
        tool_id: 'tool-1',
        tool_name: 'Write package.json',
        tool_kind: 'edit',
        parameters: { path: 'package.json' }
      }
    })

    expect(activity).toMatchObject({
      id: 'tool-1',
      toolName: 'Write package.json',
      displayName: 'Write package.json',
      category: 'write',
      status: 'running',
      startedAt: '2026-06-13T00:00:00.000Z',
      filePath: 'package.json',
      metadata: { provider: 'grok' }
    })
  })

  it('uses inner MCP tool names for bridge wrapper tools', () => {
    const activity = buildBridgeToolActivity({
      provider: 'ollama',
      activityIndex: 0,
      nowIso: () => '2026-06-13T00:00:00.000Z',
      payload: {
        tool_id: 'tool-2',
        tool_name: 'use_tool',
        parameters: {
          tool_name: 'git_status'
        }
      }
    })

    expect(activity.displayName).toBe('Git status')
    expect(activity.category).toBe('unknown')
    expect(activity.metadata).toEqual({ provider: 'ollama' })
  })

  it('categorizes bridge thinking and reasoning pseudo-tools as task activities', () => {
    const thinking = buildBridgeToolActivity({
      provider: 'cursor',
      activityIndex: 0,
      nowIso: () => '2026-06-13T00:00:00.000Z',
      payload: {
        tool_id: 'thinking-1',
        tool_name: 'cursor_thinking',
        parameters: { kind: 'reasoning' }
      }
    })
    const namespacedReasoning = buildBridgeToolActivity({
      provider: 'grok',
      activityIndex: 1,
      nowIso: () => '2026-06-13T00:00:00.000Z',
      payload: {
        tool_id: 'reasoning-1',
        tool_name: 'mcp__TaskWraith__claude_reasoning'
      }
    })

    expect(thinking.category).toBe('task')
    expect(namespacedReasoning.category).toBe('task')
  })

  it('parses stringified bridge tool arguments', () => {
    const activity = buildBridgeToolActivity({
      provider: 'codex',
      activityIndex: 0,
      nowIso: () => '2026-06-13T00:00:00.000Z',
      payload: {
        tool_id: 'tool-3',
        tool_name: 'write_file',
        arguments: '{"path":"notes.md","content":"one\\ntwo"}'
      }
    })

    expect(activity.filePath).toBe('notes.md')
    expect(activity.parameters).toMatchObject({ path: 'notes.md', content: 'one\ntwo' })
    expect(activity.diffSummary).toMatchObject({
      additions: 2,
      deletions: 0,
      source: 'content'
    })
  })

  it('projects a gateway invocation to the concrete write target with its diff evidence', () => {
    const activity = buildBridgeToolActivity({
      provider: 'mistral',
      activityIndex: 0,
      payload: {
        tool_id: 'gateway-replace',
        tool_name: 'mcp__TaskWraith__capability_invoke',
        parameters: {
          name: 'replace',
          arguments: { path: 'src/a.ts', old_string: 'before', new_string: 'after\nnext' }
        }
      }
    })

    expect(activity).toMatchObject({
      toolName: 'replace',
      category: 'write',
      filePath: 'src/a.ts',
      diffSummary: { additions: 2, deletions: 1 }
    })
  })

  it('coalesces a Codex exec wrapper carrying native Image View source', () => {
    const input =
      'const paths = ["one.png", "two.png", "three.png", "four.png"]; for (const path of paths) await tools.view_image({ path });'
    const activity = buildBridgeToolActivity({
      provider: 'codex',
      activityIndex: 0,
      payload: {
        tool_id: 'codex-images',
        tool_name: 'exec',
        input
      }
    })

    expect(activity).toMatchObject({
      toolName: 'image_view',
      displayName: 'Image View',
      category: 'read',
      parameters: { input, imageCount: 4 }
    })
  })

  it('persists one canonical Image View identity and result count', () => {
    const payload = {
      tool_id: 'images-1',
      tool_name: 'appshots',
      parameters: { count: 4 }
    }
    const activity = buildBridgeToolActivity({
      provider: 'codex',
      activityIndex: 0,
      nowIso: () => '2026-08-14T10:50:00.000Z',
      payload
    })

    expect(activity).toMatchObject({
      toolName: 'image_view',
      displayName: 'Image View',
      category: 'read',
      parameters: { imageCount: 4 },
      rawUseEvent: payload
    })

    applyBridgeToolResultIdentity(activity, {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'one' },
        { type: 'image', mimeType: 'image/png', data: 'two' }
      ]
    })
    expect(activity.parameters).toMatchObject({ imageCount: 2 })
  })
})
