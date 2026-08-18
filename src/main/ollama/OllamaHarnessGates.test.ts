import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createOllamaHarnessRunState,
  evaluateOllamaHarnessGate,
  ollamaHarnessDefaultTodos,
  ollamaHarnessTargetPaths,
  ollamaHarnessToolFollowUpPrompt,
  normalizeOllamaHarnessPath,
  recordOllamaHarnessToolResult,
  takeOllamaHarnessTodoAdvisory
} from './OllamaHarnessGates'

describe('OllamaHarnessGates', () => {
  it('canonicalizes relative and absolute aliases to workspace-relative identities', () => {
    const workspace = resolve('/tmp/taskwraith-ollama-paths')
    const file = resolve(workspace, 'src/foo.ts')

    expect(normalizeOllamaHarnessPath('./src/../src/foo.ts', workspace)).toBe('src/foo.ts')
    expect(normalizeOllamaHarnessPath(file, workspace)).toBe('src/foo.ts')
    expect(normalizeOllamaHarnessPath('src\\foo.ts', workspace)).toBe('src/foo.ts')
    expect(normalizeOllamaHarnessPath('../outside.ts', workspace)).toBe('../outside.ts')
  })

  it('does not block an edit when read and edit use different path spellings', () => {
    const workspace = resolve('/tmp/taskwraith-ollama-paths')
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(
      state,
      'workspace_search',
      { query: 'foo' },
      true,
      workspace
    )
    state = recordOllamaHarnessToolResult(
      state,
      'read_file',
      { path: './src/../src/foo.ts' },
      true,
      workspace
    )

    const gate = evaluateOllamaHarnessGate({
      modelId: 'ministral-3:3b',
      workspacePath: workspace,
      tier: 'approved_edits',
      state,
      toolName: 'replace',
      args: {
        path: resolve(workspace, 'src/foo.ts'),
        old_string: 'a',
        new_string: 'b',
        intent: 'test'
      }
    })

    expect(gate.blocked).toBe(false)
  })

  it('no longer blocks read_file before an explore call — retrieval-first is retired', () => {
    const state = createOllamaHarnessRunState()
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt_oss_20b',
      tier: 'approved_edits',
      state,
      toolName: 'read_file',
      args: { path: 'src/main/Foo.ts' }
    })
    expect(gate.blocked).toBe(false)
    expect(gate.message).toBeUndefined()
  })

  it('allows read_file after list_directory', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'list_directory', { path: 'src' }, true)
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt_oss_20b',
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
      modelId: 'gpt_oss_20b',
      tier: 'approved_edits',
      state,
      toolName: 'read_file',
      args: { path: 'src/main/Foo.ts' }
    })
    expect(gate.blocked).toBe(false)
  })

  it('no longer blocks replace on an unread file — retrieval-first is retired', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'workspace_search', { query: 'Foo' }, true)
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt_oss_20b',
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
    // Read-before-edit is now advice in the model profile prompt, not a refusal.
    expect(gate.blocked).toBe(false)
    expect(gate.message).toBeUndefined()
  })

  it('never blocks on todos — the gate has no scaffold requirement any more', () => {
    const state = createOllamaHarnessRunState()
    const gate = evaluateOllamaHarnessGate({
      modelId: 'gpt_oss_20b',
      tier: 'approved_edits',
      state,
      toolName: 'workspace_search',
      args: { query: 'foo' }
    })
    expect(gate.blocked).toBe(false)
    expect(gate.message).toBeUndefined()
  })

  it('offers the todo tip exactly once, and only while todos are unpublished', () => {
    const state = createOllamaHarnessRunState()
    const first = takeOllamaHarnessTodoAdvisory(state, 'approved_edits', 'workspace_search')
    expect(first).toContain('publish a short checklist now with todo_write')
    expect(first).toContain('your own steps, in your own words')
    expect(first).toContain('Skip it if the task is a single step')
    // One-shot: taking it again returns nothing, forever.
    expect(takeOllamaHarnessTodoAdvisory(state, 'approved_edits', 'read_file')).toBeNull()

    // Already-published todos need no encouragement, and the untaken tip stays
    // available-but-null without burning the one shot.
    const published = createOllamaHarnessRunState()
    published.publishedTodos = true
    expect(
      takeOllamaHarnessTodoAdvisory(published, 'approved_edits', 'workspace_search')
    ).toBeNull()
    expect(published.todoAdvisoryIssued).toBe(false)
  })

  it('does not pitch todo_write on its own result', () => {
    const state = createOllamaHarnessRunState()
    expect(takeOllamaHarnessTodoAdvisory(state, 'approved_edits', 'todo_write')).toBeNull()
    // Not burned: the next ordinary result still gets the tip.
    expect(takeOllamaHarnessTodoAdvisory(state, 'approved_edits', 'read_file')).not.toBeNull()
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

  it('keeps ensemble role authority salient in tool follow-up guidance', () => {
    let state = createOllamaHarnessRunState()
    state = recordOllamaHarnessToolResult(state, 'workspace_search', { query: 'foo' }, true)
    state = recordOllamaHarnessToolResult(state, 'read_file', { path: 'src/main/Foo.ts' }, true)
    state = recordOllamaHarnessToolResult(
      state,
      'replace',
      { path: 'src/main/Foo.ts', old_string: 'a', new_string: 'b', intent: 'test' },
      true
    )

    const prompt = ollamaHarnessToolFollowUpPrompt({
      toolName: 'replace',
      output: 'Patched src/main/Foo.ts',
      ok: true,
      state,
      tier: 'approved_edits',
      ensembleRun: true
    })

    expect(prompt).toContain('assigned local seat')
    expect(prompt).toContain('role / authority boundary from the capsule')
    expect(prompt).toContain('assigned ensemble slice')
    expect(prompt).not.toContain('original user request')
    expect(prompt).not.toContain('Boss/Bossman/Lead')
    expect(prompt).not.toContain('Role boundary contract')
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
