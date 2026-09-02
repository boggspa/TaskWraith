import { describe, expect, it } from 'vitest'
import {
  bridgeResultDiffStats,
  bridgeToolDiffStats,
  bridgeUnifiedDiffStats,
  parsePatchFileStats
} from './BridgeToolDiffStats'

describe('bridgeToolDiffStats (input-side derivation)', () => {
  it('counts string replaces from old/new strings (TaskWraith MCP replace, Claude Edit)', () => {
    const stats = bridgeToolDiffStats('replace', {
      path: 'src/App.tsx',
      old_string: 'one\ntwo',
      new_string: 'one\nTWO\nthree'
    })
    expect(stats).toMatchObject({
      additions: 3,
      deletions: 2,
      source: 'string_replace',
      confidence: 'exact'
    })
  })

  it('counts string replaces from AntiGravity replace_file_content (TargetContent / ReplacementContent)', () => {
    const stats = bridgeToolDiffStats('replace_file_content', {
      TargetFile: 'src/App.tsx',
      TargetContent: 'const a = 1\nconst b = 2',
      ReplacementContent: 'const a = 10\nconst b = 20\nconst c = 30'
    })
    expect(stats).toMatchObject({
      additions: 3,
      deletions: 2,
      source: 'string_replace',
      confidence: 'exact'
    })
  })

  it('counts whole-file writes from content', () => {
    const stats = bridgeToolDiffStats('write_file', { path: 'a.md', content: 'a\nb\nc' })
    expect(stats).toMatchObject({ additions: 3, deletions: 0, source: 'content' })
  })

  it('counts whole-file writes from AntiGravity write_to_file (CodeContent)', () => {
    const stats = bridgeToolDiffStats('write_to_file', {
      TargetFile: 'src/foo.ts',
      CodeContent: 'export const x = 1\nexport const y = 2\n'
    })
    expect(stats).toMatchObject({ additions: 3, deletions: 0, source: 'content' })
  })

  it('trusts explicit codex change counts', () => {
    const stats = bridgeToolDiffStats('edit_file', {
      changes: [
        { path: 'a.ts', additions: 4, deletions: 1 },
        { path: 'b.ts', added: 2 }
      ]
    })
    expect(stats).toMatchObject({
      additions: 6,
      deletions: 1,
      source: 'codex_changes',
      confidence: 'exact'
    })
  })

  it('counts ± lines in codex apply_patch envelopes (no unified-diff headers)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/main.ts',
      ' context',
      '-old line',
      '+new line',
      '+another line',
      '*** End Patch'
    ].join('\n')
    const stats = bridgeToolDiffStats('apply_patch', { patch })
    expect(stats).toMatchObject({
      additions: 2,
      deletions: 1,
      source: 'patch_preview',
      confidence: 'exact'
    })
  })

  it('treats a content-y patchPreview on a create-kind edit as +lines, never 0/0 exact', () => {
    // codex fileChange `add` items preview the NEW FILE CONTENT on the patch
    // field — pre-fix this returned {0,0,'patch_preview','exact'} (or nothing),
    // so created files never showed a chip on phones.
    const stats = bridgeToolDiffStats('edit_file', {
      kind: 'add',
      patchPreview: '# Added Diff Fixture\n\nline one\nline two'
    })
    expect(stats).toMatchObject({
      additions: 4,
      deletions: 0,
      source: 'content',
      confidence: 'estimated'
    })
  })

  it('falls through a zero-count patch on a non-create edit instead of minting 0/0', () => {
    const stats = bridgeToolDiffStats('edit_file', {
      kind: 'update',
      patchPreview: 'prose without any diff markers'
    })
    expect(stats).toBeUndefined()
  })
})

describe('parsePatchFileStats (per-file evidence + card filenames)', () => {
  it('splits a multi-file unified diff into per-file ± counts', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      '+more',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y'
    ].join('\n')
    expect(parsePatchFileStats(patch)).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 1 }
    ])
  })

  it('classifies bare-pair deletions and creations (/dev/null markers)', () => {
    const patch = [
      '--- a/gone.json',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
      '--- /dev/null',
      '+++ b/fresh.md',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two'
    ].join('\n')
    expect(parsePatchFileStats(patch)).toEqual([
      { path: 'gone.json', status: 'deleted', additions: 0, deletions: 3 },
      { path: 'fresh.md', status: 'created', additions: 2, deletions: 0 }
    ])
  })

  it('refines a git-header deletion instead of opening a duplicate', () => {
    const patch = [
      'diff --git a/dead.txt b/dead.txt',
      '--- a/dead.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye'
    ].join('\n')
    expect(parsePatchFileStats(patch)).toEqual([
      { path: 'dead.txt', status: 'deleted', additions: 0, deletions: 1 }
    ])
  })

  it('reads codex apply_patch envelope verbs', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes/new.md',
      '+hello',
      '+world',
      '*** Update File: src/main.ts',
      '-old line',
      '+new line',
      '*** Delete File: tmp/scratch.txt',
      '*** End Patch'
    ].join('\n')
    expect(parsePatchFileStats(patch)).toEqual([
      { path: 'notes/new.md', status: 'created', additions: 2, deletions: 0 },
      { path: 'src/main.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'tmp/scratch.txt', status: 'deleted', additions: 0, deletions: 0 }
    ])
  })
})

describe('bridgeUnifiedDiffStats (structure gate)', () => {
  it('requires diff structure so prose bullets never mint counts', () => {
    expect(bridgeUnifiedDiffStats('- a markdown bullet\n+ a plus bullet')).toBeUndefined()
    expect(bridgeUnifiedDiffStats('@@ -1,2 +1,3 @@\n-old\n+new\n+more')).toEqual({
      additions: 2,
      deletions: 1
    })
  })
})

describe('bridgeResultDiffStats (result-side derivation)', () => {
  it('prefers explicit forwarded change counts', () => {
    const stats = bridgeResultDiffStats({
      toolName: 'edit_file',
      summary: 'whatever',
      changes: [{ path: 'a.ts', additions: 5, deletions: 2 }]
    })
    expect(stats).toMatchObject({ additions: 5, deletions: 2, source: 'codex_changes' })
  })

  it('falls back to structural diff counting of the result text', () => {
    const stats = bridgeResultDiffStats({
      toolName: 'edit_file',
      summary: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-x\n+y\n+z'
    })
    expect(stats).toMatchObject({ additions: 2, deletions: 1, source: 'result_diff' })
  })

  it('counts Codex apply_patch envelopes in a result as well as an input', () => {
    expect(
      bridgeResultDiffStats({
        toolName: 'apply_patch',
        summary: '*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n+next\n*** End Patch'
      })
    ).toMatchObject({
      additions: 2,
      deletions: 1,
      files: [{ path: 'src/a.ts', additions: 2, deletions: 1 }]
    })
  })

  it('counts a create-kind result as content (+lines) when no diff structure exists', () => {
    const stats = bridgeResultDiffStats({
      toolName: 'edit_file',
      kind: 'add',
      summary: '# Added Diff Fixture\n\nbody line'
    })
    expect(stats).toMatchObject({ additions: 3, deletions: 0, source: 'content' })
  })

  it('never derives for reasoning pseudo-tools or structureless non-create results', () => {
    expect(
      bridgeResultDiffStats({ toolName: 'grok_thinking', kind: 'add', summary: '+looks\n-diffy' })
    ).toBeUndefined()
    expect(
      bridgeResultDiffStats({
        toolName: 'edit_file',
        summary: 'The file was updated successfully.'
      })
    ).toBeUndefined()
  })
})

describe('shell-command edit evidence (bridge lane)', () => {
  const heredocWrite = "cat > src/app.py << 'HEREDOC'\nline1\nline2\nline3\nHEREDOC"

  it('derives an estimated content summary for run_shell_command heredoc writes', () => {
    expect(bridgeToolDiffStats('run_shell_command', { command: heredocWrite })).toEqual({
      additions: 3,
      deletions: 0,
      files: [{ path: 'src/app.py', status: 'modified', additions: 3, deletions: 0 }],
      source: 'content',
      confidence: 'estimated'
    })
  })

  it('derives patch counts with per-file evidence from a git apply heredoc', () => {
    const command = [
      "git apply <<'PATCH'",
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line',
      '-old',
      '+new',
      '+more',
      'PATCH'
    ].join('\n')
    expect(bridgeToolDiffStats('run_shell_command', { command })).toMatchObject({
      additions: 2,
      deletions: 1,
      files: [{ path: 'a.ts', additions: 2, deletions: 1 }],
      source: 'patch_preview',
      confidence: 'estimated'
    })
  })

  it('stays silent for read-only shell commands', () => {
    expect(bridgeToolDiffStats('run_shell_command', { command: 'git diff HEAD~1' })).toBeUndefined()
  })

  it('coalesces provider shell aliases into the same command derivation', () => {
    expect(bridgeToolDiffStats('Shell', { command: heredocWrite })).toMatchObject({
      additions: 3,
      deletions: 0
    })
  })

  it('never counts shell RESULT text as a diff', () => {
    expect(
      bridgeResultDiffStats({
        toolName: 'run_shell_command',
        summary: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-x\n+y\n+z'
      })
    ).toBeUndefined()
  })
})
