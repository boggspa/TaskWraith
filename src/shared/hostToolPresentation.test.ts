import { describe, expect, it } from 'vitest'

import { buildHostToolPresentation } from './hostToolPresentation'

describe('hostToolPresentation', () => {
  it('builds a bounded replacement hunk with line numbers and counts', () => {
    const presentation = buildHostToolPresentation({
      toolName: 'Edit',
      input: {
        file_path: 'src/example.ts',
        old_string: 'one\ntwo',
        new_string: 'one\nthree\nfour',
        line_start: 18
      }
    })

    expect(presentation).toMatchObject({
      file: 'src/example.ts',
      additions: 2,
      deletions: 1,
      diff: {
        hunks: [
          {
            header: '@@ -18,2 +18,3 @@',
            lines: [
              { type: 'context', text: 'one', oldLine: 18, newLine: 18 },
              { type: 'del', text: 'two', oldLine: 19 },
              { type: 'add', text: 'three', newLine: 19 },
              { type: 'add', text: 'four', newLine: 20 }
            ]
          }
        ]
      }
    })
  })

  it('parses unified patch hunks and keeps command output presentation bounded', () => {
    const patch = buildHostToolPresentation({
      toolName: 'apply_patch',
      input: {
        file_path: 'src/example.ts',
        patch: '@@ -4,1 +4,2 @@\n-old\n+new\n+next'
      }
    })
    expect(patch.diff).toEqual({
      hunks: [
        {
          header: '@@ -4,1 +4,2 @@',
          lines: [
            { type: 'del', text: 'old', oldLine: 4 },
            { type: 'add', text: 'new', newLine: 4 },
            { type: 'add', text: 'next', newLine: 5 }
          ]
        }
      ]
    })

    const command = buildHostToolPresentation({
      toolName: 'run_shell_command',
      input: { command: 'npm test' },
      output: `token=secret-value\npassed\n${'x'.repeat(5_000)}`
    })
    expect(command.command).toEqual({
      command: 'npm test',
      output: expect.stringContaining('token=[redacted]'),
      truncated: true
    })
    expect(command.command?.output?.length).toBeLessThanOrEqual(4_000)
  })
})
