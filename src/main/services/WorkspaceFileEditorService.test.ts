import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { MAX_EDITOR_FILES } from '../index.constants'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  workspaceFileEtag
} from './WorkspaceFileEditorService'

let cleanupPaths: string[] = []

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'tw-file-editor-'))
  cleanupPaths.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })))
  cleanupPaths = []
})

describe('WorkspaceFileEditorService', () => {
  it('lists editable workspace files with desktop filtering rules', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(join(workspace, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(workspace, 'src/App.swift'), 'print("hi")\n')
    await writeFile(join(workspace, '.env'), 'TOKEN=x\n')
    await writeFile(join(workspace, '.secret'), 'nope\n')
    await writeFile(join(workspace, 'node_modules/pkg/index.js'), 'ignored\n')

    const result = await listWorkspaceFiles(workspace)

    expect(result.entries.map((entry) => entry.path)).toEqual(['src', 'src/App.swift', '.env'])
    expect(result.truncated).toBe(false)
  })

  it('lists one directory level and searches paths without returning contents', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'src/components'), { recursive: true })
    await mkdir(join(workspace, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(workspace, 'src/App.tsx'), '<App />\n')
    await writeFile(join(workspace, 'src/components/Button.tsx'), '<button />\n')
    await writeFile(join(workspace, 'node_modules/pkg/index.js'), 'ignored\n')

    const root = await listWorkspaceFiles(workspace, { path: '', limit: 20 })
    expect(root.entries.map((entry) => entry.path)).toEqual(['src'])
    expect(root.entries[0]).toMatchObject({ isDirectory: true, hasChildren: true, depth: 0 })
    expect(root.truncated).toBe(false)

    const src = await listWorkspaceFiles(workspace, { path: 'src', limit: 20 })
    expect(src.entries.map((entry) => entry.path)).toEqual(['src/components', 'src/App.tsx'])
    expect(src.entries.find((entry) => entry.path === 'src/App.tsx')).toMatchObject({
      isDirectory: false,
      sizeBytes: 8,
      depth: 1
    })

    const search = await listWorkspaceFiles(workspace, { query: 'button', limit: 20 })
    expect(search.entries.map((entry) => entry.path)).toEqual(['src/components/Button.tsx'])
    expect(search.entries[0]).not.toHaveProperty('content')
  })

  it('finds source files through directory listing and search when the flat list truncates early', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'design-assets'), { recursive: true })
    await mkdir(join(workspace, 'src'), { recursive: true })
    await Promise.all(
      Array.from({ length: MAX_EDITOR_FILES + 5 }, (_, index) =>
        writeFile(
          join(workspace, 'design-assets', `asset-${String(index).padStart(4, '0')}.svg`),
          '<svg />\n'
        )
      )
    )
    await writeFile(join(workspace, 'src/App.tsx'), '<App />\n')

    const flat = await listWorkspaceFiles(workspace)
    expect(flat.truncated).toBe(true)

    const src = await listWorkspaceFiles(workspace, { path: 'src', limit: 20 })
    expect(src.entries.map((entry) => entry.path)).toContain('src/App.tsx')

    const search = await listWorkspaceFiles(workspace, { query: 'App.tsx', limit: 20 })
    expect(search.entries.map((entry) => entry.path)).toEqual(['src/App.tsx'])
  })

  it('reads UTF-8 text with etag metadata and rejects traversal/binary files', async () => {
    const workspace = await makeWorkspace()
    const outside = await makeWorkspace()
    await writeFile(join(workspace, 'README.md'), '# hello\n')
    await writeFile(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(outside, 'secret.txt'), 'secret\n')

    const file = await readWorkspaceFile(workspace, 'README.md')

    expect(file).toMatchObject({
      path: 'README.md',
      content: '# hello\n',
      sizeBytes: 8,
      etag: workspaceFileEtag(Buffer.from('# hello\n'))
    })
    expect(file.mtimeMs).toEqual(expect.any(Number))
    await expect(readWorkspaceFile(workspace, '../secret.txt')).rejects.toThrow(/outside/)
    await expect(readWorkspaceFile(workspace, 'binary.dat')).rejects.toThrow(/binary|utf-8/i)
  })

  it('requires a current etag and records atomic text saves', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'note.txt'), 'old\n')
    const initial = await readWorkspaceFile(workspace, 'note.txt')
    const recordChange = vi.fn((input): any => ({
      schemaVersion: 1,
      id: 'change-1',
      source: 'editor',
      status: 'captured',
      title: 'Edited note.txt',
      workspacePath: input.workspacePath,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      files: [],
      artifacts: [],
      stats: {
        filesChanged: 1,
        filesCreated: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesPreExisting: 1,
        artifactsGenerated: 0,
        additions: 1,
        deletions: 1
      },
      metadata: input.metadata
    }))

    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'note.txt',
        content: 'new\n'
      })
    ).rejects.toThrow(/base file version/i)

    await writeFile(join(workspace, 'note.txt'), 'other\n')
    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'note.txt',
        content: 'new\n',
        baseEtag: initial.etag
      })
    ).rejects.toThrow(/changed on disk/i)

    const current = await readWorkspaceFile(workspace, 'note.txt')
    const saved = await writeWorkspaceFile({
      workspacePath: workspace,
      workspaceId: 'ws-1',
      filePath: 'note.txt',
      content: 'new\n',
      baseEtag: current.etag,
      origin: 'ios-file-editor',
      recordChange
    })

    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new\n')
    expect(saved.content).toBe('new\n')
    expect(saved.etag).toBe(workspaceFileEtag(Buffer.from('new\n')))
    expect(saved.changeSet?.metadata).toEqual({ origin: 'ios-file-editor' })
    expect(recordChange).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        filePath: 'note.txt',
        existedBefore: true,
        previousContent: 'other\n',
        nextContent: 'new\n',
        metadata: { origin: 'ios-file-editor' }
      })
    )
  })

  it('rejects oversized incoming content and null bytes', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'note.txt'), 'old\n')
    const initial = await readWorkspaceFile(workspace, 'note.txt')

    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'note.txt',
        content: 'a'.repeat(1_500_001),
        baseEtag: initial.etag
      })
    ).rejects.toThrow(/too large/i)
    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'note.txt',
        content: 'bad\u0000content',
        baseEtag: initial.etag
      })
    ).rejects.toThrow(/binary/i)
  })
})
