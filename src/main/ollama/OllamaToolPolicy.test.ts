import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceToolContext } from '../mcp/WorkspaceToolExecutors'
import {
  assertOllamaMutationIntent,
  assertOllamaProtectedWritePaths,
  ollamaShellApprovalPreviewMetadata,
  ollamaShellRiskLabels,
  ollamaTextDiffPreview,
  ollamaProtectedPathReason,
  ollamaToolRequiresModalApproval
} from './OllamaToolPolicy'

const workspace = '/tmp/taskwraith-ollama-policy'
const context: WorkspaceToolContext = {
  scope: 'workspace',
  cwd: workspace,
  workspacePath: workspace
}

function samplePatch(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new'
  ].join('\n')
}

describe('Ollama tool policy', () => {
  it('requires intent for mutating file and shell tools only', () => {
    expect(() => assertOllamaMutationIntent('read_file', {})).not.toThrow()
    expect(() => assertOllamaMutationIntent('write_file', { path: 'note.md' })).toThrow(
      /requires an intent or summary/
    )
    expect(() =>
      assertOllamaMutationIntent('write_file', {
        path: 'note.md',
        intent: 'Create the requested note.'
      })
    ).not.toThrow()
    expect(() =>
      assertOllamaMutationIntent('move_path', {
        from: 'old.md',
        to: 'new.md'
      })
    ).toThrow(/requires an intent or summary/)
    expect(() =>
      assertOllamaMutationIntent('run_shell_command', {
        command: 'npm test',
        summary: 'Run the focused test suite.'
      })
    ).not.toThrow()
  })

  it('denies protected workspace paths before approval', () => {
    expect(ollamaProtectedPathReason('.env.local')).toMatch(/environment/)
    expect(ollamaProtectedPathReason('package.json')).toMatch(/control file/)
    expect(ollamaProtectedPathReason('.github/workflows/ci.yml')).toMatch(/CI/)
    expect(ollamaProtectedPathReason('certs/dev.pem')).toMatch(/credential/)

    expect(() =>
      assertOllamaProtectedWritePaths('write_file', { path: '.env.local' }, context, workspace)
    ).toThrow(/environment\/secret files are protected/)
    expect(() =>
      assertOllamaProtectedWritePaths(
        'move_path',
        { from: 'notes/ok.md', to: '.github/workflows/ci.yml' },
        context,
        workspace
      )
    ).toThrow(/CI\/workflow configuration is protected/)
    expect(() =>
      assertOllamaProtectedWritePaths(
        'apply_patch',
        { patch: samplePatch('.github/workflows/ci.yml') },
        context,
        workspace
      )
    ).toThrow(/CI\/workflow configuration is protected/)
  })

  it('rejects path escapes while allowing ordinary workspace edits', () => {
    expect(() =>
      assertOllamaProtectedWritePaths('write_file', { path: 'notes/ok.md' }, context, workspace)
    ).not.toThrow()
    expect(() =>
      assertOllamaProtectedWritePaths(
        'rename_path',
        { path: 'notes/ok.md', newName: 'renamed.md' },
        context,
        workspace
      )
    ).not.toThrow()
    expect(() =>
      assertOllamaProtectedWritePaths('apply_patch', { patch: samplePatch('src/ok.ts') }, context, workspace)
    ).not.toThrow()

    expect(() =>
      assertOllamaProtectedWritePaths('write_file', { path: '../outside.md' }, context, workspace)
    ).toThrow(/outside the workspace/)
    expect(() =>
      assertOllamaProtectedWritePaths(
        'apply_patch',
        { patch: samplePatch('../outside.md') },
        context,
        workspace
      )
    ).toThrow(/must stay inside the workspace/)
  })

  it('rejects symlink escapes through workspace paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-ollama-policy-'))
    const workspacePath = join(root, 'workspace')
    const outsidePath = join(root, 'outside')
    await mkdir(workspacePath)
    await mkdir(outsidePath)
    await symlink(outsidePath, join(workspacePath, 'escape'), 'dir')
    const symlinkContext: WorkspaceToolContext = {
      scope: 'workspace',
      cwd: workspacePath,
      workspacePath
    }
    try {
      expect(() =>
        assertOllamaProtectedWritePaths(
          'write_file',
          { path: 'escape/outside.md' },
          symlinkContext,
          workspacePath
        )
      ).toThrow(/outside the workspace/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forces per-call modals for Tier 2 and Tier 3 mutation requests', () => {
    expect(ollamaToolRequiresModalApproval('write_file', 'approved_edits')).toBe(true)
    expect(ollamaToolRequiresModalApproval('delete_path', 'approved_edits')).toBe(true)
    expect(ollamaToolRequiresModalApproval('move_path', 'approved_edits')).toBe(true)
    expect(ollamaToolRequiresModalApproval('apply_patch', 'approved_edits')).toBe(true)
    expect(ollamaToolRequiresModalApproval('run_shell_command', 'approved_shell')).toBe(true)
    expect(ollamaToolRequiresModalApproval('run_task', 'approved_shell')).toBe(true)
    expect(ollamaToolRequiresModalApproval('find_files', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('workspace_search', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('git_log', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('git_show', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('git_blame', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('test_result_summary', 'approved_shell')).toBe(false)
    expect(ollamaToolRequiresModalApproval('write_file', 'provider_parity')).toBe(false)
    expect(ollamaToolRequiresModalApproval('run_shell_command', 'read_only')).toBe(true)
  })

  it('adds host-derived shell approval metadata for Ollama commands', () => {
    expect(ollamaShellRiskLabels('npm install left-pad && git add package.json')).toEqual(
      expect.arrayContaining(['workspace shell execution', 'dependency change', 'git mutation'])
    )
    const preview = ollamaShellApprovalPreviewMetadata('rm -rf dist')
    expect(preview.envDeltas).toEqual({ FORCE_COLOR: '0', NO_COLOR: '1' })
    expect(preview.riskLabels).toEqual(
      expect.arrayContaining(['workspace shell execution', 'deletes files'])
    )
  })

  it('generates a TaskWraith diff preview for Ollama file edits', () => {
    expect(ollamaTextDiffPreview('notes.md', null, 'hello\nworld')).toContain('--- /dev/null')
    expect(ollamaTextDiffPreview('notes.md', 'old', 'new')).toContain('-old\n+new')
  })
})
