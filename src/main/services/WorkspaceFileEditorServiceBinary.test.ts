/**
 * Binary/base64 lane coverage for WorkspaceFileEditorService — the opt-in
 * added for the Office suite. The default utf8 contract (NUL and non-UTF-8
 * rejection, 1.5 MB cap) is pinned by WorkspaceFileEditorService.test.ts;
 * these tests prove the base64 lane relaxes exactly what it must and
 * nothing else.
 */

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readWorkspaceFile,
  WorkspaceFileEditorError,
  writeWorkspaceFile
} from './WorkspaceFileEditorService'

let cleanupPaths: string[] = []

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'tw-binary-editor-'))
  cleanupPaths.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })))
  cleanupPaths = []
})

const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x01])

describe('base64 lane', () => {
  it('creates, reads back and overwrites binary content with etag concurrency', async () => {
    const workspace = await makeWorkspace()
    const created = await writeWorkspaceFile({
      workspacePath: workspace,
      filePath: 'blob.docx',
      content: BINARY.toString('base64'),
      baseEtag: null,
      contentEncoding: 'base64'
    })
    expect((await readFile(join(workspace, 'blob.docx'))).equals(BINARY)).toBe(true)

    const read = await readWorkspaceFile(workspace, 'blob.docx', { encoding: 'base64' })
    expect(Buffer.from(read.content, 'base64').equals(BINARY)).toBe(true)
    expect(read.etag).toBe(created.etag)

    const next = Buffer.concat([BINARY, Buffer.from([0x00, 0x99])])
    const overwritten = await writeWorkspaceFile({
      workspacePath: workspace,
      filePath: 'blob.docx',
      content: next.toString('base64'),
      baseEtag: read.etag,
      contentEncoding: 'base64'
    })
    expect(overwritten.etag).not.toBe(created.etag)
    expect((await readFile(join(workspace, 'blob.docx'))).equals(next)).toBe(true)
  })

  it('rejects stale etags on binary overwrites', async () => {
    const workspace = await makeWorkspace()
    const created = await writeWorkspaceFile({
      workspacePath: workspace,
      filePath: 'blob.bin',
      content: BINARY.toString('base64'),
      baseEtag: null,
      contentEncoding: 'base64'
    })
    await writeFile(join(workspace, 'blob.bin'), Buffer.from([1, 2, 3]))
    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'blob.bin',
        content: BINARY.toString('base64'),
        baseEtag: created.etag,
        contentEncoding: 'base64'
      })
    ).rejects.toThrow(/changed on disk/)
  })

  it('honors the per-call maxBytes override in both directions', async () => {
    const workspace = await makeWorkspace()
    const big = Buffer.alloc(2_000_000, 7)
    // Above the default text cap, below the explicit override → allowed.
    await writeWorkspaceFile({
      workspacePath: workspace,
      filePath: 'big.bin',
      content: big.toString('base64'),
      baseEtag: null,
      contentEncoding: 'base64',
      maxBytes: 25_000_000
    })
    const read = await readWorkspaceFile(workspace, 'big.bin', {
      encoding: 'base64',
      maxBytes: 25_000_000
    })
    expect(read.sizeBytes).toBe(big.length)

    // Default cap still applies when no override is passed.
    await expect(readWorkspaceFile(workspace, 'big.bin', { encoding: 'base64' })).rejects.toThrow(
      /too large/
    )
    await expect(
      writeWorkspaceFile({
        workspacePath: workspace,
        filePath: 'big2.bin',
        content: big.toString('base64'),
        baseEtag: null,
        contentEncoding: 'base64'
      })
    ).rejects.toThrow(/too large/)
  })

  it('keeps the utf8 lane strict: binary reads still fail without the opt-in', async () => {
    const workspace = await makeWorkspace()
    await writeWorkspaceFile({
      workspacePath: workspace,
      filePath: 'blob.docx',
      content: BINARY.toString('base64'),
      baseEtag: null,
      contentEncoding: 'base64'
    })
    try {
      await readWorkspaceFile(workspace, 'blob.docx')
      expect.unreachable('utf8 read of binary content must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFileEditorError)
      expect((error as WorkspaceFileEditorError).code).toBe('binary_file')
    }
  })
})
