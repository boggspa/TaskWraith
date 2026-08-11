import { describe, expect, it } from 'vitest'
import {
  CANVAS_FILL_RESULT_REDACTED,
  OLLAMA_COMPRESSION_PRESSURE_SHARE,
  appendOllamaTrajectoryEntry,
  compressOllamaMessagesWithWorkingMemory,
  createEmptyOllamaSessionMemory,
  normalizeOllamaSessionMemoryMap,
  pruneOllamaSessionMemoryForPersist,
  resolveOllamaWorkingMemoryLimits,
  shouldCompressOllamaMessagesForPressure,
  shouldRollOllamaRunSummary,
  upsertOllamaSessionMemory
} from './OllamaRunMemory'
import {
  CANVAS_EVAL_RESULT_REDACTED,
  createCanvasEvalApprovalReceipt
} from '../canvas/CanvasEvalAudit'

describe('OllamaRunMemory', () => {
  it('rolls working memory after every third tool turn', () => {
    expect(shouldRollOllamaRunSummary(3)).toBe(true)
    expect(shouldRollOllamaRunSummary(2)).toBe(false)
  })

  it('falls back to the turn cadence when the window is unmeasured', () => {
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: 2_000,
        usableContextTokens: undefined,
        toolTurnCount: 3
      })
    ).toBe(true)
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: 2_000,
        usableContextTokens: null,
        toolTurnCount: 2
      })
    ).toBe(false)
  })

  it('keeps a measured large window uncompressed until real context pressure', () => {
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: 5_000,
        usableContextTokens: 262_144,
        toolTurnCount: 3
      })
    ).toBe(false)
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: 180_000,
        usableContextTokens: 262_144,
        toolTurnCount: 1
      })
    ).toBe(true)
  })

  it('compresses only above the pressure share, not at it', () => {
    const usable = 100_000
    const threshold = Math.round(usable * OLLAMA_COMPRESSION_PRESSURE_SHARE)
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: threshold,
        usableContextTokens: usable,
        toolTurnCount: 3
      })
    ).toBe(false)
    expect(
      shouldCompressOllamaMessagesForPressure({
        estimatedPromptTokens: threshold + 1,
        usableContextTokens: usable,
        toolTurnCount: 1
      })
    ).toBe(true)
  })

  it('compresses the in-flight loop to system + initial user + working memory', () => {
    const memory = appendOllamaTrajectoryEntry(createEmptyOllamaSessionMemory('gpt-oss:20b'), {
      toolName: 'workspace_search',
      args: { query: 'foo' },
      ok: true,
      resultSummary: '1 match'
    })
    const compressed = compressOllamaMessagesWithWorkingMemory(
      [
        { role: 'system', content: 'tools' },
        { role: 'user', content: 'find foo' },
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'raw tool output', tool_name: 'workspace_search' }
      ],
      memory.workingMemory
    )
    expect(compressed).toHaveLength(3)
    expect(compressed[2]?.content).toContain('working memory')
  })

  it('keeps unknown local tags on conservative working-memory limits', () => {
    const limits = resolveOllamaWorkingMemoryLimits('unknown-local:latest')
    expect(limits.toolResultMaxChars).toBe(220)
    expect(limits.workingMemoryMaxChars).toBe(1800)
  })

  it('retains more tool trajectory for known large-context Ollama models', () => {
    const limits = resolveOllamaWorkingMemoryLimits('ornith:35b')
    expect(limits.toolResultMaxChars).toBeGreaterThanOrEqual(1000)
    expect(limits.workingMemoryMaxChars).toBeGreaterThan(10_000)
    expect(resolveOllamaWorkingMemoryLimits('lfm2.5:8b').workingMemoryMaxChars).toBeGreaterThan(
      resolveOllamaWorkingMemoryLimits('unknown-local:latest').workingMemoryMaxChars
    )
    expect(resolveOllamaWorkingMemoryLimits('laguna-xs-2.1:q8_0').workingMemoryMaxChars).toBeGreaterThan(
      10_000
    )
    expect(
      resolveOllamaWorkingMemoryLimits('devstral-small-2:24b').toolResultMaxChars
    ).toBeGreaterThan(resolveOllamaWorkingMemoryLimits('ministral-3:14b').toolResultMaxChars)
    expect(
      resolveOllamaWorkingMemoryLimits('ministral-3:14b').toolResultMaxChars
    ).toBeGreaterThan(resolveOllamaWorkingMemoryLimits('qwen3.5:4b').toolResultMaxChars)
    expect(resolveOllamaWorkingMemoryLimits('qwen3.5:4b').workingMemoryMaxChars).toBeGreaterThan(
      resolveOllamaWorkingMemoryLimits('unknown-local:latest').workingMemoryMaxChars
    )
    expect(resolveOllamaWorkingMemoryLimits('llama3.2:3b').workingMemoryMaxChars).toBeGreaterThan(
      resolveOllamaWorkingMemoryLimits('unknown-local:latest').workingMemoryMaxChars
    )
    expect(resolveOllamaWorkingMemoryLimits('deepseek-r1:8b').toolResultMaxChars).toBe(760)
    expect(resolveOllamaWorkingMemoryLimits('rnj-1').toolResultMaxChars).toBe(760)
    expect(resolveOllamaWorkingMemoryLimits('glm-4.7-flash:q4_K_M').toolResultMaxChars).toBe(1200)
    expect(
      resolveOllamaWorkingMemoryLimits('north-mini-code-1.0:q4_K_M').workingMemoryMaxChars
    ).toBeGreaterThan(10_000)
    expect(
      resolveOllamaWorkingMemoryLimits('muse-glimmer:30b-mlx').workingMemoryMaxChars
    ).toBeGreaterThan(resolveOllamaWorkingMemoryLimits('llama3.1:8b').workingMemoryMaxChars)
    expect(resolveOllamaWorkingMemoryLimits('muse-glimmer:30b-mlx').toolResultMaxChars).toBe(1200)
    expect(
      resolveOllamaWorkingMemoryLimits('nemotron-3.5-lightning:30b-mlx').workingMemoryMaxChars
    ).toBeGreaterThan(resolveOllamaWorkingMemoryLimits('llama3.1:8b').workingMemoryMaxChars)
    expect(
      resolveOllamaWorkingMemoryLimits('nemotron-3.5-lightning:30b-mlx').toolResultMaxChars
    ).toBe(1200)
    for (const modelId of [
      'ministral-3:3b',
      'granite4:3b',
      'qwen3.5:2b',
      'deepseek-r1:1.5b',
      'nemotron-3-nano:4b',
      'lfm2.5-thinking:1.2b',
      'gemma3:4b'
    ]) {
      expect(resolveOllamaWorkingMemoryLimits(modelId).toolResultMaxChars).toBe(420)
    }

    const output = 'A'.repeat(1600)
    const memory = appendOllamaTrajectoryEntry(createEmptyOllamaSessionMemory('ornith:35b'), {
      toolName: 'read_file',
      args: { path: 'src/main/ollama/OllamaProvider.ts' },
      ok: true,
      resultSummary: output
    })

    expect(memory.trajectory?.[0]?.resultSummary.length).toBeGreaterThan(1000)
    expect(memory.trajectory?.[0]?.resultSummary.length).toBeLessThan(output.length)
  })

  it('persists model-scaled working memory instead of the legacy fixed cap', () => {
    const memory = {
      ...createEmptyOllamaSessionMemory('ornith:35b'),
      workingMemory: 'x'.repeat(6000),
      toolTurnCount: 4
    }

    const pruned = pruneOllamaSessionMemoryForPersist(memory)

    expect(pruned.workingMemory).toHaveLength(6000)
  })

  it('retains only an approval-bound receipt for direct canvas_eval trajectory', () => {
    const script = 'globalThis.__OLLAMA_CANVAS_SCRIPT_SECRET__ = "swordfish"'
    const result = 'OLLAMA_CANVAS_RESULT_SECRET: swordfish'
    const receipt = createCanvasEvalApprovalReceipt(script, 'approval-ollama-direct')

    const memory = appendOllamaTrajectoryEntry(createEmptyOllamaSessionMemory('gpt-oss:20b'), {
      toolName: 'canvas_eval',
      args: { canvasId: 'canvas-1', script },
      ok: true,
      resultSummary: result,
      canvasEvalApproval: receipt
    })
    const persisted = pruneOllamaSessionMemoryForPersist(memory)
    const serialized = JSON.stringify(persisted)

    expect(serialized).not.toContain('__OLLAMA_CANVAS_SCRIPT_SECRET__')
    expect(serialized).not.toContain('OLLAMA_CANVAS_RESULT_SECRET')
    expect(persisted.trajectory?.[0]).toMatchObject({
      toolName: 'canvas_eval',
      effectiveToolName: 'canvas_eval',
      argsSummary: 'canvas_eval script=[redacted]',
      resultSummary: CANVAS_EVAL_RESULT_REDACTED,
      canvasEvalReceipt: receipt
    })
    expect(persisted.workingMemory).toContain(CANVAS_EVAL_RESULT_REDACTED)
  })

  it('redacts nested capability_invoke canvas_eval errors even without a receipt', () => {
    const script = 'throw new Error("OLLAMA_NESTED_SCRIPT_SECRET")'
    const error = 'OLLAMA_NESTED_ERROR_SECRET: stack included script text'

    const memory = appendOllamaTrajectoryEntry(createEmptyOllamaSessionMemory('gpt-oss:20b'), {
      toolName: 'capability_invoke',
      args: {
        name: 'canvas_eval',
        arguments: { canvasId: 'canvas-2', script }
      },
      ok: false,
      resultSummary: error
    })
    const persisted = pruneOllamaSessionMemoryForPersist(memory)
    const serialized = JSON.stringify(persisted)

    expect(serialized).not.toContain('OLLAMA_NESTED_SCRIPT_SECRET')
    expect(serialized).not.toContain('OLLAMA_NESTED_ERROR_SECRET')
    expect(persisted.trajectory?.[0]).toEqual({
      toolName: 'capability_invoke',
      effectiveToolName: 'canvas_eval',
      argsSummary: 'capability_invoke name=canvas_eval script=[redacted]',
      ok: false,
      resultSummary: CANVAS_EVAL_RESULT_REDACTED
    })
  })

  it('re-sanitizes canvas_eval entries at the final persistence boundary', () => {
    const persisted = pruneOllamaSessionMemoryForPersist({
      ...createEmptyOllamaSessionMemory('gpt-oss:20b'),
      workingMemory: 'LEGACY_CANVAS_RESULT_SECRET',
      toolTurnCount: 1,
      trajectory: [
        {
          toolName: 'canvas_eval',
          argsSummary: 'canvas_eval LEGACY_CANVAS_SCRIPT_SECRET',
          ok: false,
          resultSummary: 'LEGACY_CANVAS_RESULT_SECRET'
        }
      ]
    })

    expect(JSON.stringify(persisted)).not.toContain('LEGACY_CANVAS_SCRIPT_SECRET')
    expect(JSON.stringify(persisted)).not.toContain('LEGACY_CANVAS_RESULT_SECRET')
    expect(persisted.trajectory?.[0]?.resultSummary).toBe(CANVAS_EVAL_RESULT_REDACTED)
  })

  it('redacts canvas_fill values and retry guidance across direct and gateway memory routes', () => {
    const secret = '__OLLAMA_CANVAS_FILL_MEMORY_SECRET__'
    const routes = [
      {
        toolName: 'canvas_fill',
        args: { canvasId: 'canvas-1', ref: 'field-1', value: secret }
      },
      {
        toolName: 'capability_invoke',
        args: {
          name: 'canvas_fill',
          arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret }
        }
      },
      {
        toolName: 'request_tool_permission',
        args: {
          toolName: 'canvas_fill',
          arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret },
          failure: 'permission denied'
        }
      },
      {
        toolName: 'capability_invoke',
        args: {
          name: 'request_tool_permission',
          arguments: {
            toolName: 'canvas_fill',
            arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret },
            failure: 'permission denied'
          }
        }
      }
    ]
    let memory = createEmptyOllamaSessionMemory('ornith:35b')
    for (const route of routes) {
      memory = appendOllamaTrajectoryEntry(memory, {
        ...route,
        ok: false,
        resultSummary: JSON.stringify({
          error: 'permission denied',
          permissionRetry: route,
          secret
        })
      })
    }
    const persisted = pruneOllamaSessionMemoryForPersist(memory)
    expect(JSON.stringify(persisted)).not.toContain(secret)
    expect(persisted.trajectory).toHaveLength(routes.length)
    for (const entry of persisted.trajectory || []) {
      expect(entry.effectiveToolName).toBe('canvas_fill')
      expect(entry.argsSummary).toContain('value=[redacted]')
      expect(entry.resultSummary).toBe(CANVAS_FILL_RESULT_REDACTED)
    }
    expect(persisted.workingMemory).toContain(CANVAS_FILL_RESULT_REDACTED)
  })

  it('re-sanitizes legacy canvas_fill memory at the final persistence boundary', () => {
    const secret = '__LEGACY_CANVAS_FILL_MEMORY_SECRET__'
    const persisted = pruneOllamaSessionMemoryForPersist({
      ...createEmptyOllamaSessionMemory('ornith:35b'),
      workingMemory: secret,
      toolTurnCount: 1,
      trajectory: [
        {
          toolName: 'request_tool_permission',
          effectiveToolName: 'canvas_fill',
          argsSummary: `request_tool_permission target=canvas_fill value=${secret}`,
          ok: false,
          resultSummary: secret
        }
      ]
    })

    expect(JSON.stringify(persisted)).not.toContain(secret)
    expect(persisted.trajectory?.[0]?.resultSummary).toBe(CANVAS_FILL_RESULT_REDACTED)
  })

  it('keeps ensemble Ollama memory buckets isolated by safe seat key', () => {
    const qwenMemory = {
      ...createEmptyOllamaSessionMemory('qwen3.6:35b'),
      workingMemory: 'Qwen prior trajectory',
      toolTurnCount: 1
    }
    const lfmMemory = {
      ...createEmptyOllamaSessionMemory('lfm2.5:8b'),
      workingMemory: 'LFM prior trajectory',
      toolTurnCount: 1
    }

    const memories = upsertOllamaSessionMemory(
      upsertOllamaSessionMemory(null, 'ensemble:qwen36', qwenMemory),
      'ensemble:lfm',
      lfmMemory
    )

    expect(memories['ensemble:qwen36']?.workingMemory).toBe('Qwen prior trajectory')
    expect(memories['ensemble:lfm']?.workingMemory).toBe('LFM prior trajectory')
    expect(normalizeOllamaSessionMemoryMap({
      'ensemble:lfm': lfmMemory,
      '../../bad': qwenMemory
    })['../../bad']).toBeUndefined()
  })
})
