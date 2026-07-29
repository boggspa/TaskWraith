import { describe, expect, it } from 'vitest'

import { workspaceLockMcpResourcePath } from './WorkspaceLockMcpResourceScope'

describe('workspaceLockMcpResourcePath', () => {
  it('resolves a single path role against the effective checkout', () => {
    expect(
      workspaceLockMcpResourcePath(
        'write_file',
        { path: 'src/file.ts' },
        '/workspace-lane'
      )
    ).toBe('/workspace-lane/src/file.ts')
  })

  it('requires workspace scope for multi-path and repository mutations', () => {
    expect(
      workspaceLockMcpResourcePath(
        'move_path',
        { source: 'src/a.ts', destination: 'src/b.ts' },
        '/workspace'
      )
    ).toBeUndefined()
    expect(
      workspaceLockMcpResourcePath(
        'apply_patch',
        { patch: '*** Begin Patch' },
        '/workspace'
      )
    ).toBeUndefined()
    expect(
      workspaceLockMcpResourcePath('git_stage', { paths: ['src/a.ts'] }, '/workspace')
    ).toBeUndefined()
  })

  it('preserves absolute external targets so lane scope rejects them', () => {
    expect(
      workspaceLockMcpResourcePath(
        'replace',
        { file_path: '/outside/file.ts' },
        '/workspace'
      )
    ).toBe('/outside/file.ts')
  })

  it('preserves exact non-empty path bytes during lane validation', () => {
    expect(
      workspaceLockMcpResourcePath('write_file', { path: 'src/file.ts ' }, '/workspace')
    ).toBe('/workspace/src/file.ts ')
  })
})
