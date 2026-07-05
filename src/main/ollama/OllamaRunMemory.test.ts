import { describe, expect, it } from 'vitest'
import {
  appendOllamaTrajectoryEntry,
  compressOllamaMessagesWithWorkingMemory,
  createEmptyOllamaSessionMemory,
  normalizeOllamaSessionMemoryMap,
  pruneOllamaSessionMemoryForPersist,
  resolveOllamaWorkingMemoryLimits,
  shouldRollOllamaRunSummary,
  upsertOllamaSessionMemory
} from './OllamaRunMemory'

describe('OllamaRunMemory', () => {
  it('rolls working memory after every third tool turn', () => {
    expect(shouldRollOllamaRunSummary(3)).toBe(true)
    expect(shouldRollOllamaRunSummary(2)).toBe(false)
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
