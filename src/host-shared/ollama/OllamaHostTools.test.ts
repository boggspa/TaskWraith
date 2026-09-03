import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createOllamaHostToolExecutor, ollamaHostToolDefinitions } from './OllamaHostTools'

const roots: string[] = []

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ollama-host-tools-')))
  roots.push(root)
  return root
}

function names(options: { write: boolean }): string[] {
  return ollamaHostToolDefinitions(options).map((entry) => entry.function.name)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('ollamaHostToolDefinitions', () => {
  it('advertises only the read set to a seat that may not edit', () => {
    expect(names({ write: false })).toEqual(['read_file', 'list_dir'])
  })

  it('advertises the write set to a seat that may edit', () => {
    expect(names({ write: true })).toEqual([
      'read_file',
      'list_dir',
      'write_file',
      'replace_in_file'
    ])
  })
})

describe('createOllamaHostToolExecutor', () => {
  it('reads a workspace file', async () => {
    const root = workspace()
    writeFileSync(join(root, 'note.txt'), 'hello')
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    await expect(execute({ name: 'read_file', arguments: { path: 'note.txt' } })).resolves.toEqual({
      ok: true,
      result: 'hello'
    })
  })

  it('marks directories with a trailing separator when listing', async () => {
    const root = workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'top.txt'), 'x')
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const listed = await execute({ name: 'list_dir', arguments: { path: '.' } })
    expect(listed.ok).toBe(true)
    expect(listed.result.split('\n').sort()).toEqual(['src/', 'top.txt'])
  })

  it('refuses a relative path that climbs out of the workspace', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const refused = await execute({ name: 'read_file', arguments: { path: '../escape.txt' } })
    expect(refused.ok).toBe(false)
    expect(refused.result).toContain('escapes the workspace')
  })

  it('refuses an absolute path outside the workspace', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const refused = await execute({ name: 'read_file', arguments: { path: '/etc/hosts' } })
    expect(refused.ok).toBe(false)
    expect(refused.result).toContain('escapes the workspace')
  })

  it('refuses a symlink whose real target leaves the workspace', async () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'private')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const refused = await execute({ name: 'read_file', arguments: { path: 'link.txt' } })
    expect(refused.ok).toBe(false)
    expect(refused.result).toContain('escapes the workspace')
  })

  it('refuses a write tool the read-only tier never advertised', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const refused = await execute({
      name: 'write_file',
      arguments: { path: 'new.txt', content: 'x' }
    })
    expect(refused.ok).toBe(false)
    expect(refused.result).toContain("not available for this thread's permission tier")
    expect(() => realpathSync(join(root, 'new.txt'))).toThrow()
  })

  it('creates parent directories for a write on a permitted seat', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: true })
    const written = await execute({
      name: 'write_file',
      arguments: { path: 'nested/deep/new.txt', content: 'body' }
    })
    expect(written.ok).toBe(true)
    const readBack = await execute({
      name: 'read_file',
      arguments: { path: 'nested/deep/new.txt' }
    })
    expect(readBack.result).toBe('body')
  })

  it('replaces every occurrence and reports the count', async () => {
    const root = workspace()
    writeFileSync(join(root, 'code.ts'), 'a\na\nb')
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: true })
    const replaced = await execute({
      name: 'replace_in_file',
      arguments: { path: 'code.ts', old: 'a', new: 'z' }
    })
    expect(replaced.ok).toBe(true)
    expect(replaced.result).toContain('2 occurrence(s)')
    const readBack = await execute({ name: 'read_file', arguments: { path: 'code.ts' } })
    expect(readBack.result).toBe('z\nz\nb')
  })

  it('fails legibly when the replaced text does not occur', async () => {
    const root = workspace()
    writeFileSync(join(root, 'code.ts'), 'unchanged')
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: true })
    const missed = await execute({
      name: 'replace_in_file',
      arguments: { path: 'code.ts', old: 'absent', new: 'z' }
    })
    expect(missed.ok).toBe(false)
    expect(missed.result).toContain('does not occur')
    const readBack = await execute({ name: 'read_file', arguments: { path: 'code.ts' } })
    expect(readBack.result).toBe('unchanged')
  })

  it('reports an unknown tool rather than throwing', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: true })
    const unknown = await execute({ name: 'run_shell_command', arguments: {} })
    expect(unknown.ok).toBe(false)
    expect(unknown.result).toContain("not available for this thread's permission tier")
  })

  it('turns a missing file into a legible failure, not a rejection', async () => {
    const root = workspace()
    const execute = createOllamaHostToolExecutor({ workspaceRoot: root, write: false })
    const missing = await execute({ name: 'read_file', arguments: { path: 'nope.txt' } })
    expect(missing.ok).toBe(false)
    expect(missing.result).toContain('read_file failed:')
  })
})
