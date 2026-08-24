import { describe, expect, it } from 'vitest'
import {
  applyBridgeToolResultIdentity,
  bridgeAssistantMessageMetadata,
  bridgeModelMetadataFromEvent,
  buildBridgeToolActivity
} from './BridgeTranscriptActivity'

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
