import { describe, expect, it } from 'vitest'
import { summarizeOllamaToolResult } from './OllamaToolResultSummary'

describe('summarizeOllamaToolResult', () => {
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
})
