import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createToolResultMediaRefs,
  sniffImageMime,
  validateWorkspaceImagePath
} from './TranscriptMediaService'

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const PNG_BUFFER = Buffer.from(PNG_1X1_BASE64, 'base64')

const tempRoots: string[] = []

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-media-test-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('TranscriptMediaService', () => {
  it('sniffs supported raster formats and rejects svg as unsafe for direct media rendering', () => {
    expect(sniffImageMime(PNG_BUFFER)).toBe('image/png')
    expect(sniffImageMime(Buffer.from('<svg><title>fixture</title></svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(Buffer.from('not an image'))).toBeNull()
  })

  it('creates bounded tool result media refs with thumbnails', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-1',
      runId: 'run-1',
      toolName: 'capture',
      blocks: [{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }],
      thumbnailer: () => ({
        dataBase64: 'thumb',
        mimeType: 'image/jpeg',
        width: 1,
        height: 1
      })
    })

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      kind: 'image',
      format: 'raster',
      source: 'tool_result',
      name: 'capture image 1',
      mimeType: 'image/png',
      byteLength: PNG_BUFFER.length,
      status: 'available',
      thumbnail: { dataBase64: 'thumb', mimeType: 'image/jpeg', width: 1, height: 1 }
    })
    expect(refs[0].sha256).toBeTruthy()
    expect(refs[0].assetId).toContain('run:run-1:tool-image:')
  })

  it('marks tool SVG and oversized tool images as non-renderable instead of exposing data URLs', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-1',
      blocks: [
        { type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }
      ],
      maxBytes: 4,
      thumbnailer: () => null
    })

    expect(refs).toHaveLength(2)
    expect(refs[0].status).toBe('unsafe_svg')
    expect(refs[0].format).toBe('svg')
    expect(refs[0].thumbnail).toBeUndefined()
    expect(refs[1].status).toBe('too_large')
    expect(refs[1].thumbnail).toBeUndefined()
  })

  it('validates workspace image paths by realpath and rejects symlink escapes', () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    const insideImage = path.join(workspace, 'image.png')
    const outsideImage = path.join(outside, 'secret.png')
    fs.writeFileSync(insideImage, PNG_BUFFER)
    fs.writeFileSync(outsideImage, PNG_BUFFER)
    fs.symlinkSync(outsideImage, path.join(workspace, 'linked-secret.png'))

    const valid = validateWorkspaceImagePath({
      workspacePath: workspace,
      candidatePath: insideImage
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.mimeType).toBe('image/png')
      expect(valid.workspaceRelativePath).toBe('image.png')
    }

    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: path.join(workspace, 'linked-secret.png')
      })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })
  })

  it('allows explicitly granted external paths but still rejects svg and oversized files', () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const external = path.join(root, 'external')
    fs.mkdirSync(workspace)
    fs.mkdirSync(external)
    const externalImage = path.join(external, 'shot.png')
    const externalSvg = path.join(external, 'bad.svg')
    fs.writeFileSync(externalImage, PNG_BUFFER)
    fs.writeFileSync(externalSvg, '<svg><title>fixture</title></svg>')

    const granted = validateWorkspaceImagePath({
      workspacePath: workspace,
      candidatePath: externalImage,
      externalPathGrants: [
        {
          id: 'grant-1',
          provider: 'codex',
          workspaceId: 'ws',
          chatId: 'chat',
          path: external,
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          createdAt: new Date().toISOString()
        }
      ]
    })
    expect(granted.ok).toBe(true)

    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: externalSvg,
        externalPathGrants: [
          {
            id: 'grant-1',
            provider: 'codex',
            workspaceId: 'ws',
            chatId: 'chat',
            path: external,
            kind: 'directory',
            access: 'read',
            duration: 'thisRun',
            createdAt: new Date().toISOString()
          }
        ]
      })
    ).toEqual({ ok: false, reason: 'unsafe_svg' })

    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: externalImage,
        externalPathGrants: [],
        maxBytes: 4
      })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })
  })
})
