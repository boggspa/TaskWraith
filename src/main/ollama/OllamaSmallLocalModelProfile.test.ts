import { describe, expect, it } from 'vitest'

import {
  OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOLS,
  applyOllamaSmallLocalModelToolArguments,
  isOllamaSmallLocalModel,
  ollamaSmallLocalModelPromptLines,
  parseOllamaModelSizeBillions,
  resolveOllamaModelSizeBillions
} from './OllamaSmallLocalModelProfile'
import { ollamaAdvertisedToolNames } from './OllamaToolTiers'
import { ollamaLocalToolSystemPrompt } from './OllamaModelProfiles'
import { ollamaNativeToolDefinitions } from './OllamaProvider'

describe('parseOllamaModelSizeBillions', () => {
  it('reads the size token from ordinary tags', () => {
    expect(parseOllamaModelSizeBillions('qwen3:4b')).toBe(4)
    expect(parseOllamaModelSizeBillions('gemma3:1b')).toBe(1)
    expect(parseOllamaModelSizeBillions('llama3.2:3b')).toBe(3)
    expect(parseOllamaModelSizeBillions('deepseek-r1:1.5b')).toBe(1.5)
    expect(parseOllamaModelSizeBillions('phi3:3.8b')).toBe(3.8)
    expect(parseOllamaModelSizeBillions('gpt-oss:20b')).toBe(20)
    expect(parseOllamaModelSizeBillions('qwen3.5:397b')).toBe(397)
  })

  it('reads a reported parameter_size string', () => {
    expect(parseOllamaModelSizeBillions('1.5B')).toBe(1.5)
    expect(parseOllamaModelSizeBillions('4.3B')).toBe(4.3)
    expect(parseOllamaModelSizeBillions('30.5B')).toBe(30.5)
  })

  // The exact bug the retired retrieval-first gate shipped: it matched family
  // names by normalized SUBSTRING, so `granite4_1_3b` (3B) and
  // `granite4_1_30b` (30B) differed by a single character and both matched.
  it('separates a 3B tag from a 30B tag', () => {
    expect(parseOllamaModelSizeBillions('granite4_1_3b')).toBe(3)
    expect(parseOllamaModelSizeBillions('granite4_1_30b')).toBe(30)
  })

  it('never reads an MoE active-parameter count as the model size', () => {
    // `30b-a3b` is 30B total / 3B active. The `a` before `3b` blocks the match,
    // and the largest-token rule would still return 30 if it did not.
    expect(parseOllamaModelSizeBillions('qwen3:30b-a3b')).toBe(30)
    expect(parseOllamaModelSizeBillions('qwen3-coder:30b-a3b-q4_K_M')).toBe(30)
  })

  it('never reads a version digit as a size', () => {
    expect(parseOllamaModelSizeBillions('gemma3')).toBeNull()
    expect(parseOllamaModelSizeBillions('qwen3')).toBeNull()
    expect(parseOllamaModelSizeBillions('llama3.2:latest')).toBeNull()
    // 8x7b: the 7 is preceded by `x`, so no size is claimed at all.
    expect(parseOllamaModelSizeBillions('mixtral:8x7b')).toBeNull()
  })

  it('accepts a millions suffix and survives quantization suffixes', () => {
    expect(parseOllamaModelSizeBillions('smollm2:135m')).toBeCloseTo(0.135)
    expect(parseOllamaModelSizeBillions('qwen2.5-coder:1.5b-instruct-q4_K_M')).toBe(1.5)
  })

  it('returns null for an unparseable value', () => {
    expect(parseOllamaModelSizeBillions('')).toBeNull()
    expect(parseOllamaModelSizeBillions(null)).toBeNull()
    expect(parseOllamaModelSizeBillions('nomic-embed-text:v1.5')).toBeNull()
  })
})

describe('resolveOllamaModelSizeBillions', () => {
  it('prefers the larger of the reported size and the tag size', () => {
    // Disagreement resolves upward: over-estimating keeps a large model out of
    // the small profile, which is the safe direction.
    expect(resolveOllamaModelSizeBillions('mystery:3b', { parameterSize: '30B' })).toBe(30)
    expect(resolveOllamaModelSizeBillions('mystery:30b', { parameterSize: '3B' })).toBe(30)
  })

  it('falls back to whichever signal exists', () => {
    expect(resolveOllamaModelSizeBillions('gemma3', { parameterSize: '4.3B' })).toBe(4.3)
    expect(resolveOllamaModelSizeBillions('gemma3:4b', {})).toBe(4)
    expect(resolveOllamaModelSizeBillions('gemma3', {})).toBeNull()
  })
})

describe('isOllamaSmallLocalModel', () => {
  it('accepts local models at or below the ceiling', () => {
    expect(isOllamaSmallLocalModel('qwen2.5:1.5b')).toBe(true)
    expect(isOllamaSmallLocalModel('gemma2:2b')).toBe(true)
    expect(isOllamaSmallLocalModel('llama3.2:3b')).toBe(true)
    expect(isOllamaSmallLocalModel('qwen3:4b')).toBe(true)
    // A nominal 4B tag that reports 4.3B actual parameters still qualifies.
    expect(isOllamaSmallLocalModel('gemma3:4b', { parameterSize: '4.3B' })).toBe(true)
  })

  it('leaves more capable local models alone', () => {
    expect(isOllamaSmallLocalModel('qwen3:8b')).toBe(false)
    expect(isOllamaSmallLocalModel('mistral:7b')).toBe(false)
    expect(isOllamaSmallLocalModel('gpt-oss:20b')).toBe(false)
    expect(isOllamaSmallLocalModel('granite4_1_30b')).toBe(false)
    expect(isOllamaSmallLocalModel('qwen3:30b-a3b')).toBe(false)
  })

  it('never applies to Ollama Cloud', () => {
    expect(isOllamaSmallLocalModel('gemma3:4b-cloud')).toBe(false)
    expect(isOllamaSmallLocalModel('gemma3:4b:cloud')).toBe(false)
    expect(isOllamaSmallLocalModel('gemma3:4b', { isCloud: true })).toBe(false)
  })

  it('keeps the full surface when the size is unknown', () => {
    expect(isOllamaSmallLocalModel('gemma3')).toBe(false)
    expect(isOllamaSmallLocalModel('some-new-model:latest')).toBe(false)
    expect(isOllamaSmallLocalModel(null)).toBe(false)
  })
})

describe('advertised surface', () => {
  it('narrows a small local model to the compact working set', () => {
    const small = ollamaAdvertisedToolNames({ smallLocalModel: true })
    const full = ollamaAdvertisedToolNames({})
    expect(small.length).toBeLessThan(full.length)
    expect(small.length).toBe(OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOLS.length)
    for (const toolName of small) {
      expect(full).toContain(toolName)
    }
  })

  it('leaves a capable model on the unchanged full surface', () => {
    expect(ollamaAdvertisedToolNames({ smallLocalModel: false })).toEqual(
      ollamaAdvertisedToolNames({})
    )
  })

  // The whole point: this is a context budget, not a capability gate.
  it('keeps the mutation and shell tools advertised for a small model', () => {
    const small = ollamaAdvertisedToolNames({ smallLocalModel: true })
    expect(small).toContain('write_file')
    expect(small).toContain('replace')
    expect(small).toContain('run_shell_command')
  })

  it('still honours read-only posture for a small model', () => {
    const small = ollamaAdvertisedToolNames({ smallLocalModel: true, readOnly: true })
    expect(small).not.toContain('write_file')
    expect(small).not.toContain('replace')
    expect(small).not.toContain('run_shell_command')
    expect(small).toContain('read_file')
  })

  it('does not overrule an explicit UltraTask delegation consent', () => {
    const small = ollamaAdvertisedToolNames({
      smallLocalModel: true,
      ultraTaskDelegationAutoAllow: true
    })
    expect(small).toContain('ultra_task')
  })

  it('forces the compact per-definition schemas for a small model', () => {
    const readFileOf = (defs: ReturnType<typeof ollamaNativeToolDefinitions>): string =>
      defs.find((definition) => definition.function.name === 'read_file')!.function.description
    expect(
      readFileOf(ollamaNativeToolDefinitions('provider_parity', { smallLocalModel: true }))
    ).toBe('Read workspace file.')
    expect(readFileOf(ollamaNativeToolDefinitions('provider_parity', {}))).toBe(
      'Read a UTF-8 text file inside the active workspace.'
    )
  })

  it('leaves the capability gateway escape hatch on the native schema', () => {
    const defs = ollamaNativeToolDefinitions('provider_parity', { smallLocalModel: true })
    const names = defs.map((definition) => definition.function.name)
    // The narrowed-away tail must stay ONE lookup away, not unreachable.
    expect(names).toContain('capability_search')
    expect(names).toContain('capability_invoke')
    expect(names).toContain('tool_help')
    expect(names).not.toContain('ensemble_fanout')
    expect(names.length).toBeLessThan(ollamaNativeToolDefinitions('provider_parity', {}).length)
  })
})

describe('system prompt directive', () => {
  const directiveHead = ollamaSmallLocalModelPromptLines()[0]

  it('carries the working directive for a small local model', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'qwen3:4b', {
      smallLocalModel: true
    })
    expect(prompt).toContain(directiveHead)
    expect(prompt).toContain('startLine/endLine')
    expect(prompt).toContain('small slices')
  })

  it('omits the directive for a capable model', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'qwen3:8b', {})
    expect(prompt).not.toContain(directiveHead)
  })

  it('omits the directive on a conversational turn', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'qwen3:4b', {
      smallLocalModel: true,
      intent: 'conversational'
    })
    expect(prompt).not.toContain(directiveHead)
  })

  // The 2026-08 un-nerf removed defer-the-work text from local prompts as a
  // standing design decision. This directive must never reintroduce it.
  it('never tells the model to hand its work back', () => {
    const directive = ollamaSmallLocalModelPromptLines().join('\n').toLowerCase()
    expect(directive).not.toContain('summarize and stop')
    expect(directive).not.toContain('suggest delegation')
    expect(directive).not.toContain('prefer a concise plan')
    expect(directive).toContain('do not stop to hand the work back')
  })
})

describe('pre-tool argument hooks', () => {
  it('bounds an unbounded read_file', () => {
    expect(applyOllamaSmallLocalModelToolArguments('read_file', { path: 'a.ts' })).toEqual({
      path: 'a.ts',
      maxLines: 200
    })
  })

  it('honours a range the model chose, capping only a runaway one', () => {
    expect(
      applyOllamaSmallLocalModelToolArguments('read_file', {
        path: 'a.ts',
        startLine: 40,
        endLine: 120
      })
    ).toEqual({ path: 'a.ts', startLine: 40, endLine: 120 })
    expect(
      applyOllamaSmallLocalModelToolArguments('read_file', {
        path: 'a.ts',
        startLine: 1,
        endLine: 9000
      })
    ).toEqual({ path: 'a.ts', startLine: 1, endLine: 400 })
    expect(
      applyOllamaSmallLocalModelToolArguments('read_file', { path: 'a.ts', maxLines: 9000 })
    ).toEqual({ path: 'a.ts', maxLines: 400 })
  })

  it('supplies and clamps search economy arguments', () => {
    expect(applyOllamaSmallLocalModelToolArguments('workspace_search', { query: 'x' })).toEqual({
      query: 'x',
      maxResults: 20,
      contextLines: 2
    })
    expect(
      applyOllamaSmallLocalModelToolArguments('workspace_search', {
        query: 'x',
        maxResults: 500,
        contextLines: 50
      })
    ).toEqual({ query: 'x', maxResults: 50, contextLines: 4 })
    expect(applyOllamaSmallLocalModelToolArguments('find_files', { pattern: '*.ts' })).toEqual({
      pattern: '*.ts',
      maxResults: 30
    })
  })

  it('defaults an omitted list_directory path instead of bouncing the call', () => {
    expect(applyOllamaSmallLocalModelToolArguments('list_directory', {})).toEqual({ path: '.' })
    expect(applyOllamaSmallLocalModelToolArguments('list_directory', { path: 'src' })).toEqual({
      path: 'src'
    })
  })

  // Bounding a write would silently corrupt the user's file, and rewriting
  // `intent` would hollow out assertOllamaMutationIntent.
  it('never touches mutation or shell arguments', () => {
    const write = { path: 'a.ts', content: 'x'.repeat(50_000), intent: 'add the thing' }
    expect(applyOllamaSmallLocalModelToolArguments('write_file', write)).toEqual(write)
    const replace = { path: 'a.ts', old_string: 'a', new_string: 'b', intent: 'fix' }
    expect(applyOllamaSmallLocalModelToolArguments('replace', replace)).toEqual(replace)
    const shell = { command: 'npm test -- --run' }
    expect(applyOllamaSmallLocalModelToolArguments('run_shell_command', shell)).toEqual(shell)
  })

  it('leaves tools outside the small working set untouched', () => {
    const args = { query: 'x', maxResults: 500 }
    expect(applyOllamaSmallLocalModelToolArguments('web_search', args)).toEqual(args)
    expect(applyOllamaSmallLocalModelToolArguments('ensemble_fanout', args)).toEqual(args)
  })

  it('cannot refuse a call', () => {
    for (const toolName of OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOLS) {
      const result = applyOllamaSmallLocalModelToolArguments(toolName, {})
      expect(result).toBeTypeOf('object')
      expect(result).not.toBeNull()
    }
  })
})
