import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { workspaceLockMcpResourcePath } from './WorkspaceLockMcpResourceScope'

describe('workspaceLockMcpResourcePath', () => {
  it('resolves a single path role against the effective checkout', () => {
    const result = workspaceLockMcpResourcePath(
      'write_file',
      { path: 'src/file.ts' },
      '/workspace-lane'
    )
    expect(result).toBe(resolve('/workspace-lane', 'src/file.ts'))
  })

  it('leaves multi-path and repository mutations to complete exact-set derivation', () => {
    expect(
      workspaceLockMcpResourcePath(
        'move_path',
        { source: 'src/a.ts', destination: 'src/b.ts' },
        '/workspace'
      )
    ).toBeUndefined()
    expect(
      workspaceLockMcpResourcePath('apply_patch', { patch: '*** Begin Patch' }, '/workspace')
    ).toBeUndefined()
    expect(
      workspaceLockMcpResourcePath('git_stage', { paths: ['src/a.ts'] }, '/workspace')
    ).toBeUndefined()
  })

  it('preserves absolute external targets so lane scope rejects them', () => {
    const result = workspaceLockMcpResourcePath(
      'replace',
      { file_path: '/outside/file.ts' },
      '/workspace'
    )
    expect(result).toBe(resolve('/outside/file.ts'))
  })

  it('preserves exact non-empty path bytes during lane validation', () => {
    const result = workspaceLockMcpResourcePath(
      'write_file',
      { path: 'src/file.ts ' },
      '/workspace'
    )
    expect(result).toBe(resolve('/workspace', 'src/file.ts '))
  })
})
