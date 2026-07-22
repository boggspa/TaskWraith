import { describe, expect, it } from 'vitest'
import {
  attachmentPathsOutsideWorkspace,
  parseGeminiPermissionRequest
} from './GeminiPermissionParser'

describe('attachmentPathsOutsideWorkspace', () => {
  const workspace = '/Users/chris/Documents/AGBench'

  it('keeps only paths outside the workspace root', () => {
    expect(
      attachmentPathsOutsideWorkspace(
        [
          '/Users/chris/Documents/AGBench/src/main/index.ts',
          '/Users/chris/Documents/AGBench',
          '/Users/chris/Desktop/report.pdf',
          '/tmp/scratch/data.csv'
        ],
        workspace
      )
    ).toEqual(['/Users/chris/Desktop/report.pdf', '/tmp/scratch/data.csv'])
  })

  it('treats workspace-relative paths as inside and ~ paths as outside', () => {
    expect(
      attachmentPathsOutsideWorkspace(
        ['./src/app.ts', '../sibling/x.ts', '~/Downloads/img.png'],
        workspace
      )
    ).toEqual(['~/Downloads/img.png'])
  })

  it('does not treat a sibling directory sharing the root prefix as inside', () => {
    expect(
      attachmentPathsOutsideWorkspace(['/Users/chris/Documents/AGBench-notes/todo.md'], workspace)
    ).toEqual(['/Users/chris/Documents/AGBench-notes/todo.md'])
  })

  it('passes everything through when no workspace path is known', () => {
    expect(attachmentPathsOutsideWorkspace(['/tmp/a.txt'], null)).toEqual(['/tmp/a.txt'])
    expect(attachmentPathsOutsideWorkspace(['/tmp/a.txt'], '  ')).toEqual(['/tmp/a.txt'])
  })
})

describe('parseGeminiPermissionRequest heuristics', () => {
  it('still matches a genuine outside-workspace refusal', () => {
    const request = parseGeminiPermissionRequest(
      'Error: "/Users/chris/Desktop/report.pdf" is outside the workspace. Grant access to continue.'
    )
    expect(request?.kind).toBe('attachment_access')
    expect(request?.paths).toEqual(['/Users/chris/Desktop/report.pdf'])
  })

  it('matches tool output that merely mentions access phrases (why the posture gate exists upstream)', () => {
    // The parser itself is intentionally broad — the App-side gate
    // (read-only posture + outside-workspace paths) is what stops these
    // from reaching the modal on trusted/write runs.
    const request = parseGeminiPermissionRequest(
      'stdout: tests passed. Note "/tmp/probe/config.json" access denied for sandbox probe.'
    )
    expect(request).not.toBeNull()
  })
})
