import { describe, it, expect } from 'vitest'
import { detectExternalPath } from './ExternalPathDetector'

describe('detectExternalPath', () => {
  it('returns needsPrompt=true for read_file outside the workspace', () => {
    const result = detectExternalPath({
      toolName: 'read_file',
      params: { path: '/etc/hosts' },
      workspacePath: '/Users/me/code/proj'
    })
    expect(result).toEqual({
      needsPrompt: true,
      path: '/etc/hosts',
      access: 'read',
      basename: 'hosts'
    })
  })

  it('returns needsPrompt=true for find_files outside the workspace as read access', () => {
    const result = detectExternalPath({
      toolName: 'find_files',
      params: { path: '/tmp/outside' },
      workspacePath: '/Users/me/code/proj'
    })
    expect(result).toEqual({
      needsPrompt: true,
      path: '/tmp/outside',
      access: 'read',
      basename: 'outside'
    })
  })

  it('returns needsPrompt=true for write_file outside the workspace', () => {
    const result = detectExternalPath({
      toolName: 'write_file',
      params: { file_path: '/tmp/outside.txt' },
      workspacePath: '/Users/me/code/proj'
    })
    expect(result).toEqual({
      needsPrompt: true,
      path: '/tmp/outside.txt',
      access: 'write',
      basename: 'outside.txt'
    })
  })

  it('returns needsPrompt=true for lifecycle destination paths outside the workspace', () => {
    const result = detectExternalPath({
      toolName: 'move_path',
      params: { from: '/Users/me/code/proj/src/a.ts', to: '/tmp/a.ts' },
      workspacePath: '/Users/me/code/proj'
    })
    expect(result).toEqual({
      needsPrompt: true,
      path: '/tmp/a.ts',
      access: 'write',
      basename: 'a.ts'
    })
  })

  it('returns needsPrompt=false for read_file INSIDE the workspace', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/code/proj/src/foo.ts' },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })

  it('returns needsPrompt=false for non-file-IO tools (e.g. shell)', () => {
    expect(
      detectExternalPath({
        toolName: 'run_shell_command',
        params: { command: 'ls /tmp' },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })

  it('returns needsPrompt=false when params has no recognised path field', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { query: '/etc/hosts' },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })

  it('returns needsPrompt=false for relative paths (we only flag absolute)', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '../outside/file.ts' },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })

  it('respects existing grants — read covered by read grant', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/etc/hosts' },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/etc/hosts', access: 'read' }]
      })
    ).toEqual({ needsPrompt: false })
  })

  it('respects existing grants — write covered by write grant on same path', () => {
    expect(
      detectExternalPath({
        toolName: 'write_file',
        params: { file_path: '/tmp/outside.txt' },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/tmp/outside.txt', access: 'write' }]
      })
    ).toEqual({ needsPrompt: false })
  })

  it('write request NOT covered by read-only grant', () => {
    const result = detectExternalPath({
      toolName: 'write_file',
      params: { file_path: '/tmp/outside.txt' },
      workspacePath: '/Users/me/code/proj',
      existingGrants: [{ path: '/tmp/outside.txt', access: 'read' }]
    })
    expect(result.needsPrompt).toBe(true)
    expect(result.access).toBe('write')
  })

  it('respects directory-level grants — read inside granted directory', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/Other/proj/src/foo.ts' },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/Users/me/Other/proj', access: 'read' }]
      })
    ).toEqual({ needsPrompt: false })
  })

  it('treats file grants as exact-only', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/Other/proj/src/foo.ts' },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/Users/me/Other/proj', kind: 'file', access: 'read' }]
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/Other/proj/src/foo.ts',
      access: 'read',
      basename: 'foo.ts'
    })
  })

  it('treats directory grants as covering descendants', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/Other/proj/src/foo.ts' },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/Users/me/Other/proj', kind: 'directory', access: 'read' }]
      })
    ).toEqual({ needsPrompt: false })
  })

  it('strips mcp__server__ tool prefix before category lookup', () => {
    expect(
      detectExternalPath({
        toolName: 'mcp__filesystem__read_file',
        params: { path: '/etc/hosts' },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({
      needsPrompt: true,
      path: '/etc/hosts',
      access: 'read',
      basename: 'hosts'
    })
  })

  it('global chat (no workspace) treats every path as external', () => {
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/anything.txt' },
        workspacePath: undefined
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/anything.txt',
      access: 'read',
      basename: 'anything.txt'
    })
  })

  it('does not false-positive on sibling-prefix workspaces', () => {
    // `/Users/me/proj-2` should NOT be considered inside `/Users/me/proj`
    expect(
      detectExternalPath({
        toolName: 'read_file',
        params: { path: '/Users/me/proj-2/src/foo.ts' },
        workspacePath: '/Users/me/proj'
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/proj-2/src/foo.ts',
      access: 'read',
      basename: 'foo.ts'
    })
  })

  // Slice 5 v3 — Codex's `item/fileChange/requestApproval` shape.
  // No `toolName` in params; path lives inside `params.changes[].path`.
  // The detector falls back to the `method` argument to infer category
  // and digs into the changes array for the path.
  it('handles Codex fileChange approval shape', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/fileChange/requestApproval',
        params: {
          changes: [{ path: '/Users/me/Other/proj/src/bar.ts', kind: 'edit' }]
        },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/Other/proj/src/bar.ts',
      access: 'write',
      basename: 'bar.ts'
    })
  })

  it('checks all Codex fileChange paths when an inside path appears first', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/fileChange/requestApproval',
        params: {
          changes: [
            { path: '/Users/me/code/proj/src/internal.ts', kind: 'edit' },
            { path: '/Users/me/Other/proj/src/bar.ts', kind: 'edit' }
          ]
        },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/Other/proj/src/bar.ts',
      access: 'write',
      basename: 'bar.ts'
    })
  })

  it('checks later Codex fileChange paths after an earlier external path is already granted', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/fileChange/requestApproval',
        params: {
          changes: [
            { path: '/Users/me/Other/granted.ts', kind: 'edit' },
            { path: '/Users/me/Other/ungranted.ts', kind: 'edit' }
          ]
        },
        workspacePath: '/Users/me/code/proj',
        existingGrants: [{ path: '/Users/me/Other/granted.ts', kind: 'file', access: 'write' }]
      })
    ).toEqual({
      needsPrompt: true,
      path: '/Users/me/Other/ungranted.ts',
      access: 'write',
      basename: 'ungranted.ts'
    })
  })

  it('handles nested item.changes shape', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/fileChange/requestApproval',
        params: {
          item: {
            changes: [{ path: '/tmp/nested.txt', kind: 'write' }]
          }
        },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({
      needsPrompt: true,
      path: '/tmp/nested.txt',
      access: 'write',
      basename: 'nested.txt'
    })
  })

  it('ignores fileChange method when the path is INSIDE the workspace', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/fileChange/requestApproval',
        params: {
          changes: [{ path: '/Users/me/code/proj/src/internal.ts', kind: 'edit' }]
        },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })

  it('skips when method is unrelated and no toolName matches', () => {
    expect(
      detectExternalPath({
        toolName: '',
        method: 'item/permissions/requestApproval',
        params: { permissions: {} },
        workspacePath: '/Users/me/code/proj'
      })
    ).toEqual({ needsPrompt: false })
  })
})
