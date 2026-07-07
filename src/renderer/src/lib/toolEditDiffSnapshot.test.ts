import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { buildToolEditDiffSnapshotForPath, extractFilePatchChunk } from './toolEditDiffSnapshot'
import { parseUnifiedDiff } from './unifiedDiffParser'

function activity(overrides: Partial<ToolActivity>): ToolActivity {
  return {
    id: overrides.id || 'tool-1',
    toolName: overrides.toolName || 'edit_file',
    displayName: overrides.displayName || 'Edit file',
    category: 'write',
    status: overrides.status || 'success',
    ...overrides
  } as ToolActivity
}

function message(activities: ToolActivity[], id = 'msg-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: '2026-07-07T10:00:00.000Z',
    toolActivities: activities
  } as unknown as ChatMessage
}

describe('buildToolEditDiffSnapshotForPath', () => {
  it('synthesizes a replacement hunk from old_string/new_string', () => {
    const messages = [
      message([
        activity({
          toolName: 'replace',
          parameters: {
            file_path: '/ws/src/app.ts',
            old_string: 'const a = 1\nconst b = 2',
            new_string: 'const a = 10'
          }
        })
      ])
    ]
    const snapshot = buildToolEditDiffSnapshotForPath(messages, 'src/app.ts', '/ws')
    expect(snapshot).toBeTruthy()
    expect(snapshot).toContain('@@ Edit — -2 +1 @@')
    expect(snapshot).toContain('-const a = 1')
    expect(snapshot).toContain('-const b = 2')
    expect(snapshot).toContain('+const a = 10')
    const parsed = parseUnifiedDiff(snapshot!)
    expect(parsed.sections.length).toBe(1)
    expect(parsed.sections[0].lines.filter((line) => line.kind === 'del').length).toBe(2)
    expect(parsed.sections[0].lines.filter((line) => line.kind === 'add').length).toBe(1)
  })

  it('emits one hunk per MultiEdit edit with ordinals', () => {
    const messages = [
      message([
        activity({
          toolName: 'multiedit',
          parameters: {
            file_path: '/ws/src/app.ts',
            edits: [
              { old_string: 'one', new_string: 'uno' },
              { old_string: 'two', new_string: 'dos' }
            ]
          }
        })
      ])
    ]
    const snapshot = buildToolEditDiffSnapshotForPath(messages, 'src/app.ts', '/ws')
    expect(snapshot).toContain('@@ Edit 1/2 — -1 +1 @@')
    expect(snapshot).toContain('@@ Edit 2/2 — -1 +1 @@')
    expect(parseUnifiedDiff(snapshot!).sections.length).toBe(2)
  })

  it('renders full write content as additions', () => {
    const messages = [
      message([
        activity({
          toolName: 'write_file',
          parameters: {
            path: 'notes/README.md',
            content: 'hello\nworld\n'
          }
        })
      ])
    ]
    const snapshot = buildToolEditDiffSnapshotForPath(messages, 'notes/README.md', '/ws')
    expect(snapshot).toContain('@@ Write — file content (2 lines) @@')
    expect(snapshot).toContain('+hello')
    expect(snapshot).toContain('+world')
  })

  it('slices only the hovered file from a multi-file git patch', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-alpha',
      '+ALPHA',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-beta',
      '+BETA'
    ].join('\n')
    const messages = [
      message([
        activity({
          toolName: 'apply_patch',
          parameters: { patch }
        })
      ])
    ]
    const snapshot = buildToolEditDiffSnapshotForPath(messages, 'src/b.ts', '/ws')
    expect(snapshot).toContain('+BETA')
    expect(snapshot).not.toContain('ALPHA')
  })

  it('slices Codex *** Update File envelopes by path', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '-alpha',
      '+ALPHA',
      '*** Update File: src/b.ts',
      '-beta',
      '+BETA',
      '*** End Patch'
    ].join('\n')
    const messages = [message([activity({ toolName: 'apply_patch', parameters: { patch } })])]
    const snapshot = buildToolEditDiffSnapshotForPath(messages, 'src/b.ts', '/ws')
    expect(snapshot).toContain('@@ Update File: src/b.ts @@')
    expect(snapshot).toContain('+BETA')
    expect(snapshot).not.toContain('ALPHA')
  })

  it('skips errored activities and non-matching paths', () => {
    const messages = [
      message([
        activity({
          toolName: 'replace',
          status: 'error',
          parameters: {
            file_path: '/ws/src/app.ts',
            old_string: 'x',
            new_string: 'y'
          }
        }),
        activity({
          id: 'tool-2',
          toolName: 'replace',
          parameters: {
            file_path: '/ws/src/other.ts',
            old_string: 'x',
            new_string: 'y'
          }
        })
      ])
    ]
    expect(buildToolEditDiffSnapshotForPath(messages, 'src/app.ts', '/ws')).toBeNull()
  })

  it('keeps the latest edits and reports omitted ones on overflow', () => {
    const bigOld = Array.from({ length: 59 }, (_, i) => `old line ${i}`).join('\n')
    const bigNew = Array.from({ length: 59 }, (_, i) => `new line ${i}`).join('\n')
    const activities = Array.from({ length: 6 }, (_, i) =>
      activity({
        id: `tool-${i}`,
        toolName: 'replace',
        parameters: {
          file_path: '/ws/src/app.ts',
          old_string: `marker-old-${i}\n${bigOld}`,
          new_string: `marker-new-${i}\n${bigNew}`
        }
      })
    )
    const snapshot = buildToolEditDiffSnapshotForPath([message(activities)], 'src/app.ts', '/ws')
    expect(snapshot).toBeTruthy()
    expect(snapshot).toMatch(/@@ \d+ earlier edits? not shown @@/)
    expect(snapshot).toContain('marker-new-5')
    expect(snapshot).not.toContain('marker-new-0')
  })

  it('returns null when there is nothing usable', () => {
    expect(buildToolEditDiffSnapshotForPath([], 'src/app.ts', '/ws')).toBeNull()
    expect(
      buildToolEditDiffSnapshotForPath(
        [message([activity({ toolName: 'read_file', parameters: { path: 'src/app.ts' } })])],
        'src/app.ts',
        '/ws'
      )
    ).toBeNull()
  })
})

describe('extractFilePatchChunk', () => {
  it('accepts a bare single-file diff whose header names the target', () => {
    const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    expect(extractFilePatchChunk(patch, 'src/a.ts')).toContain('+y')
    expect(extractFilePatchChunk(patch, 'src/other.ts')).toBeNull()
  })

  it('accepts headerless hunk text only when the caller vouches for the file', () => {
    const patch = ['@@ -1 +1 @@', '-x', '+y'].join('\n')
    expect(extractFilePatchChunk(patch, 'anything.ts')).toBeNull()
    expect(extractFilePatchChunk(patch, 'anything.ts', { allowHeaderless: true })).toContain('+y')
  })
})
