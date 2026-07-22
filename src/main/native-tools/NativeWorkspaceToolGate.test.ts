import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightNativeWorkspaceTool } from './NativeWorkspaceToolGate'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-native-gate-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'inside.txt'), 'inside')
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('preflightNativeWorkspaceTool', () => {
  it('coalesces a human Grok title and allows an in-workspace native read', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Read file src/inside.txt',
        toolKind: 'read',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'allow',
      canonicalTool: 'read_file',
      service: 'mcpTools',
      access: 'read',
      checkedPaths: [join(root, 'src', 'inside.txt')]
    })
  })

  it('normalizes benign traversal but denies parent and sibling-prefix escapes', () => {
    const root = workspace()
    const inside = preflightNativeWorkspaceTool({
      toolName: 'Read',
      rawToolCall: { rawInput: { path: 'src/../src/inside.txt' } },
      workspacePath: root
    })
    expect(inside).toMatchObject({ kind: 'allow', canonicalTool: 'read_file' })

    for (const path of ['../outside.txt', `${root}-sibling/secret.txt`]) {
      expect(
        preflightNativeWorkspaceTool({
          toolName: 'Read',
          rawToolCall: { rawInput: { path } },
          workspacePath: root
        })
      ).toMatchObject({ kind: 'deny', canonicalTool: 'read_file' })
    }
  })

  it('denies an in-workspace symlink whose authority resolves outside', () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'taskwraith-native-gate-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'escape'))

    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Read',
        rawToolCall: { rawInput: { path: 'escape/secret.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'read_file' })
  })

  it('checks every source/destination path for native move and rename calls', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Move file',
        toolKind: 'move',
        rawToolCall: { rawInput: { source: 'src/inside.txt', destination: 'moved.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'move_path', access: 'write' })

    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Move file',
        toolKind: 'move',
        rawToolCall: { rawInput: { source: 'src/inside.txt', destination: '../moved.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'move_path' })
  })

  it('extracts unified-diff paths before allowing native apply_patch', () => {
    const root = workspace()
    const patch = [
      '--- a/src/inside.txt',
      '+++ b/src/inside.txt',
      '@@ -1 +1 @@',
      '-inside',
      '+updated'
    ].join('\n')
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'apply_patch',
        rawToolCall: { rawInput: { patch } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'apply_patch', access: 'write' })
  })

  it('fails closed when a path-bearing native tool omits its authority', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Write file',
        toolKind: 'edit',
        rawToolCall: { rawInput: { content: 'body' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'write_file' })
  })

  it('clamps shell cwd and requires a hard runtime sandbox', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: '/tmp' } },
        workspacePath: root,
        runtimeSandboxed: true
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'run_shell_command' })

    expect(
      preflightNativeWorkspaceTool({
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: 'src' } },
        workspacePath: root,
        runtimeSandboxed: false
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: 'run_shell_command',
      requiresRuntimeSandbox: true
    })

    expect(
      preflightNativeWorkspaceTool({
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: 'src' } },
        workspacePath: root,
        runtimeSandboxed: true
      })
    ).toMatchObject({
      kind: 'allow',
      canonicalTool: 'run_shell_command',
      access: 'shell',
      normalizedCwd: join(root, 'src'),
      requiresRuntimeSandbox: true
    })
  })

  it('leaves TaskWraith-qualified tools to the broker and ignores unrelated native tools', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'tool',
        rawToolCall: {
          rawInput: { tool_name: 'taskwraith-broker__write_file', path: '../outside.txt' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'write_file'
    })
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'AskUserQuestion',
        toolKind: 'other',
        workspacePath: root
      })
    ).toEqual({
      kind: 'not_applicable',
      canonicalTool: 'ask_user_question',
      source: 'unknown'
    })
  })
})
