import { describe, expect, it } from 'vitest'
import {
  OLLAMA_DEFAULT_TOOL_RESULT_LIMITS,
  resolveOllamaToolResultLimits,
  summarizeOllamaToolResult
} from './OllamaToolResultSummary'

describe('summarizeOllamaToolResult', () => {
  it('keeps moderately sized read_file bodies intact by default', () => {
    const output = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')
    const summary = summarizeOllamaToolResult('read_file', output)
    expect(summary).toBe(output)
  })

  it('keeps only the head of large read_file bodies', () => {
    const output = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n')
    const summary = summarizeOllamaToolResult('read_file', output, 2400)
    expect(summary).toContain('read_file summary')
    expect(summary.length).toBeLessThan(output.length)
  })

  it('flattens workspace_search JSON into path-line rows', () => {
    const summary = summarizeOllamaToolResult(
      'workspace_search',
      JSON.stringify({
        matches: [
          { path: 'src/main/Foo.ts', line: 12, text: 'const foo = true' },
          { path: 'src/main/Bar.ts', line: 7, text: 'foo()' }
        ]
      }),
      2400
    )
    expect(summary).toContain('src/main/Foo.ts:12: const foo = true')
    expect(summary).not.toContain('"matches"')
  })

  it('flattens find_files JSON into path rows', () => {
    const summary = summarizeOllamaToolResult(
      'find_files',
      JSON.stringify({
        files: ['src/main/Foo.ts', 'src/main/Foo.test.ts'],
        count: 2
      }),
      2400
    )

    expect(summary).toContain('src/main/Foo.ts')
    expect(summary).toContain('src/main/Foo.test.ts')
    expect(summary).not.toContain('"files"')
  })

  it('teaches offset paging when a read_file body is clamped', () => {
    const output = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n')
    const summary = summarizeOllamaToolResult('read_file', output)
    expect(summary).toContain('showing lines 1-96 of 120')
    expect(summary).toContain('call read_file again with the same path plus {"offset": 97}')
  })

  it('continues paging guidance from a windowed read_file header', () => {
    const body = Array.from({ length: 2000 }, (_, index) => `line ${index + 97}`).join('\n')
    const output = `[read_file: lines 97-2096 of 5000]\n${body}`
    const summary = summarizeOllamaToolResult('read_file', output)
    expect(summary).toContain('showing lines 97-191 of 5000')
    expect(summary).toContain('{"offset": 192}')
  })

  it('keeps a long read_file body intact under limits scaled to a large measured window', () => {
    const output = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
    const limits = resolveOllamaToolResultLimits({
      measuredContextTokens: 262_144,
      contextCapTokens: 262_144
    })
    expect(summarizeOllamaToolResult('read_file', output, limits)).toBe(output)
  })
})

describe('resolveOllamaToolResultLimits', () => {
  it('keeps the conservative floor when the window is unmeasured', () => {
    expect(resolveOllamaToolResultLimits()).toEqual(OLLAMA_DEFAULT_TOOL_RESULT_LIMITS)
    expect(
      resolveOllamaToolResultLimits({ measuredContextTokens: null, contextCapTokens: 65_536 })
    ).toEqual(OLLAMA_DEFAULT_TOOL_RESULT_LIMITS)
  })

  it('scales caps to a measured large window and honours the 2000-line read window promise', () => {
    const limits = resolveOllamaToolResultLimits({
      measuredContextTokens: 262_144,
      contextCapTokens: 524_288
    })
    expect(limits.readFileHeadLines).toBe(2000)
    expect(limits.maxChars).toBe(94_372)
    expect(limits.searchSnippetLines).toBe(200)
    expect(limits.listDirMaxLines).toBe(300)
  })

  it('respects a profile cap tighter than the measured window', () => {
    const limits = resolveOllamaToolResultLimits({
      measuredContextTokens: 262_144,
      contextCapTokens: 65_536
    })
    expect(limits.readFileHeadLines).toBe(1024)
    expect(limits.maxChars).toBe(23_593)
  })

  it('keeps a small measured window at the floor', () => {
    const limits = resolveOllamaToolResultLimits({
      measuredContextTokens: 8_192,
      contextCapTokens: 65_536
    })
    expect(limits.maxChars).toBe(OLLAMA_DEFAULT_TOOL_RESULT_LIMITS.maxChars)
    expect(limits.searchSnippetLines).toBe(OLLAMA_DEFAULT_TOOL_RESULT_LIMITS.searchSnippetLines)
    expect(limits.listDirMaxLines).toBe(OLLAMA_DEFAULT_TOOL_RESULT_LIMITS.listDirMaxLines)
    expect(limits.readFileHeadLines).toBe(128)
  })
})
