import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGeminiMcpPath, resolveScopedDirectory } from './PathScope'

describe('resolveScopedDirectory', () => {
  const workspace = resolve('/tmp/taskwraith-path-scope')

  it('keeps workspace MCP command cwd values within the workspace', () => {
    expect(resolveScopedDirectory('workspace', workspace, workspace, 'packages/app')).toBe(
      resolve(workspace, 'packages/app')
    )
    expect(resolveScopedDirectory('workspace', workspace, workspace, 'packages/../app')).toBe(
      resolve(workspace, 'app')
    )
  })

  it.each(['/tmp', '../sibling-workspace', '../../etc'])(
    'rejects an out-of-workspace MCP command cwd: %s',
    (cwd) => {
      expect(() => resolveScopedDirectory('workspace', workspace, workspace, cwd)).toThrow(
        'Command cwd is outside the workspace.'
      )
    }
  )

  it('keeps explicit host cwd behavior scoped to global chats', () => {
    expect(resolveScopedDirectory('global', workspace, undefined, '/tmp')).toBe(resolve('/tmp'))
  })
})

describe('resolveGeminiMcpPath', () => {
  it('allows the workspace root only when the caller opts in', () => {
    const workspace = resolve('/tmp/taskwraith-path-scope')

    expect(resolveGeminiMcpPath(workspace, '.', { allowWorkspaceRoot: true })).toBe(workspace)
    expect(() => resolveGeminiMcpPath(workspace, '.')).toThrow('Path is outside the workspace.')
  })

  it('still rejects paths outside the workspace', () => {
    const workspace = resolve('/tmp/taskwraith-path-scope')

    expect(() =>
      resolveGeminiMcpPath(workspace, '../outside', { allowWorkspaceRoot: true })
    ).toThrow('Path is outside the workspace.')
  })
})
