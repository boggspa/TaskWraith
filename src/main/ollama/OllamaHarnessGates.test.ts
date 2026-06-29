import { describe, expect, it } from 'vitest'
import {
  createOllamaHarnessRunState,
  evaluateOllamaHarnessGate,
  ollamaHarnessDefaultTodos,
  ollamaHarnessTargetPaths,
  ollamaHarnessToolFollowUpPrompt,
  recordOllamaHarnessToolResult
} from './OllamaHarnessGates'

describe('OllamaHarnessGates', () => {
  it('blocks read_file until explore tools run', () => {
    const state = createOllamaHarnessRunState()
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt-oss:20b',
      tier: 'approved_edits',
      state,
      toolName: 'read_file',
      args: { path: 'src/main/Foo.ts' }
    })
    expect(gate.blocked).toBe(true)
    expect(gate.message).toContain('workspace_search')
  })

  it('allows read_file after list_directory', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'list_directory', { path: 'src' }, true)
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt-oss:20b',
      tier: 'approved_edits',
      state,
      toolName: 'read_file',
      args: { path: 'src/main/Foo.ts' }
    })
    expect(gate.blocked).toBe(false)
  })

  it('allows read_file after find_files', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'find_files', { pattern: '*.ts' }, true)
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt-oss:20b',
      tier: 'approved_edits',
      state,
      toolName: 'read_file',
      args: { path: 'src/main/Foo.ts' }
    })
    expect(gate.blocked).toBe(false)
  })

  it('blocks replace until the target file was read', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'workspace_search', { query: 'Foo' }, true)
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt-oss:20b',
      tier: 'approved_edits',
      state,
      toolName: 'replace',
      args: {
        path: 'src/main/Foo.ts',
        old_string: 'a',
        new_string: 'b',
        intent: 'test'
      }
    })
    expect(gate.blocked).toBe(true)
    expect(gate.message).toContain('read_file')
  })

  it('does not require todo_write before other tools when scaffold is enabled', () => {
    const state = createOllamaHarnessRunState()
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt-oss:20b',
      tier: 'approved_edits',
      state,
      toolName: 'workspace_search',
      args: { query: 'foo' },
      requireTodoScaffold: true
    })
    expect(gate.blocked).toBe(false)
  })

  it('extracts apply_patch paths and clears read cache after edit', () => {
    expect(
      ollamaHarnessTargetPaths('apply_patch', {
        patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n'
      })
    ).toEqual(['src/foo.ts'])
    expect(
      ollamaHarnessTargetPaths('apply_patch', {
        patch: '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n'
      })
    ).toEqual(['src/new.ts'])

    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'workspace_search', { query: 'foo' }, true)
    state = recordOllamaHarnessToolResult(state, 'read_file', { path: 'src/foo.ts' }, true)
    expect(state.readPaths.has('src/foo.ts')).toBe(true)
    state = recordOllamaHarnessToolResult(
      state,
      'replace',
      { path: 'src/foo.ts', old_string: 'old', new_string: 'new', intent: 'test' },
      true
    )
    expect(state.readPaths.has('src/foo.ts')).toBe(false)
  })

  it('emits contextual follow-up guidance after search', () => {
    const state = createOllamaHarnessRunState()
    state.publishedTodos = true
    const prompt = ollamaHarnessToolFollowUpPrompt({
      toolName: 'workspace_search',
      output: 'src/main/Foo.ts:10: match',
      ok: true,
      state,
      tier: 'approved_edits'
    })
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('explore todo')
  })

  it('ships the default harness todo scaffold', () => {
    expect(ollamaHarnessDefaultTodos().map((item) => item.id)).toEqual([
      'explore',
      'read',
      'edit',
      'verify'
    ])
  })
})
