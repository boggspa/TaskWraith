import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkspacePathMediaRefs,
  createToolResultMediaRefs,
  extractMarkdownImagePathCandidates,
  extractMcpImageBlocksFromRawResult,
  extractProviderImageBlocksFromRawEvent,
  setWorkspaceMediaSnapshotTestHookForTests,
  snapshotRasterOrPdfAttachment,
  sniffImageMime,
  stageWorkspaceMediaSnapshot,
  TRANSCRIPT_MEDIA_MAX_REFS_CEILING,
  TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE,
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
  setWorkspaceMediaSnapshotTestHookForTests(undefined)
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

  it('threads mediaRefHints onto refs: labels[i] → caption, groupKind → every ref', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-frames',
      runId: 'run-frames',
      toolName: 'inspect_video_frames',
      blocks: [
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 },
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }
      ],
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg', width: 1, height: 1 }),
      hints: { groupKind: 'video_frames', labels: ['0:00', '0:03'] }
    })

    expect(refs).toHaveLength(2)
    // Caption comes from labels[i] aligned to block order.
    expect(refs[0].caption).toBe('0:00')
    expect(refs[1].caption).toBe('0:03')
    // groupKind is stamped on every produced ref so the renderer can group the run.
    expect(refs.every((ref) => ref.groupKind === 'video_frames')).toBe(true)
  })

  it('omits caption when a label is missing/empty and omits groupKind when no hints', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-partial',
      toolName: 'inspect_video_frames',
      blocks: [
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 },
        { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }
      ],
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' }),
      // Only one label, and no groupKind.
      hints: { labels: ['0:00'] }
    })

    expect(refs[0].caption).toBe('0:00')
    expect(refs[1].caption).toBeUndefined()
    expect(refs.every((ref) => ref.groupKind === undefined)).toBe(true)
  })

  it('does not set caption/groupKind when no hints are passed at all', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-nohints',
      toolName: 'capture',
      blocks: [{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }],
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' })
    })
    expect(refs[0].caption).toBeUndefined()
    expect(refs[0].groupKind).toBeUndefined()
  })

  // A run of N identical image blocks (the inspect_video_frames filmstrip shape).
  function imageBlocks(n: number) {
    return Array.from({ length: n }, () => ({ type: 'image' as const, mimeType: 'image/png', data: PNG_1X1_BASE64 }))
  }

  it('caps refs at the default of 8 when no maxRefs override is given', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-default',
      toolName: 'inspect_video_frames',
      blocks: imageBlocks(20),
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' })
    })
    expect(refs).toHaveLength(TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE)
    expect(TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE).toBe(8)
  })

  it('honors a per-call maxRefs override above the default (e.g. a 24-frame filmstrip)', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-24',
      toolName: 'inspect_video_frames',
      blocks: imageBlocks(24),
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' }),
      maxRefs: 24
    })
    expect(refs).toHaveLength(24)
  })

  it('also honors maxRefs supplied via the hints mirror', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-hints-24',
      toolName: 'inspect_video_frames',
      blocks: imageBlocks(24),
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' }),
      hints: { groupKind: 'video_frames', maxRefs: 24 }
    })
    expect(refs).toHaveLength(24)
  })

  it('CEILING-clamps a forged/oversized maxRefs to 32 (a hostile hint cannot blow up the count)', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-forged',
      toolName: 'inspect_video_frames',
      blocks: imageBlocks(100),
      thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' }),
      maxRefs: 9999
    })
    expect(refs).toHaveLength(TRANSCRIPT_MEDIA_MAX_REFS_CEILING)
    expect(TRANSCRIPT_MEDIA_MAX_REFS_CEILING).toBe(32)
  })

  it('falls back to the default for a non-finite / < 1 maxRefs', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const refs = createToolResultMediaRefs({
        messageId: `msg-bad-${bad}`,
        toolName: 'inspect_video_frames',
        blocks: imageBlocks(20),
        thumbnailer: () => ({ dataBase64: 'thumb', mimeType: 'image/jpeg' }),
        maxRefs: bad
      })
      expect(refs).toHaveLength(TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE)
    }
  })

  it('extracts nested MCP image blocks from raw result envelopes', () => {
    const blocks = extractMcpImageBlocksFromRawResult({
      result: JSON.stringify({
        content: [
          { type: 'text', text: 'ignored' },
          { type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }
        ]
      })
    })

    expect(blocks).toEqual([{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }])
  })

  it('extracts provider assistant image blocks from common base64 content shapes', () => {
    const blocks = extractProviderImageBlocksFromRawEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Here is the image.' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_BASE64 }
          },
          {
            inlineData: { mimeType: 'image/png', data: PNG_1X1_BASE64 }
          },
          {
            type: 'output_image',
            image_url: `data:image/png;base64,${PNG_1X1_BASE64}`
          }
        ]
      }
    })

    expect(blocks).toEqual([{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }])
  })

  it('extracts local markdown image paths while ignoring remote, data, and code-block refs', () => {
    const candidates = extractMarkdownImagePathCandidates(
      [
        '![Preview](./image.png)',
        '![External](https://example.test/image.png)',
        '![Data](data:image/png;base64,abc)',
        '`![Inline](inline.png)`',
        '```',
        '![Fenced](fenced.png)',
        '```',
        '![Spaced](<folder/image with spaces.png>)'
      ].join('\n')
    )

    expect(candidates).toEqual([
      { alt: 'Preview', path: './image.png' },
      { alt: 'Spaced', path: 'folder/image with spaces.png' }
    ])
  })

  it('creates workspace-path media refs for safe assistant markdown image paths', () => {
    const workspace = makeTempRoot()
    const imagePath = path.join(workspace, 'image.png')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    const refs = createWorkspacePathMediaRefs({
      messageId: 'msg-1',
      workspaceId: 'ws-1',
      workspacePath: workspace,
      content: 'Here is the output:\n\n![Result](image.png)',
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
      source: 'workspace_path',
      name: 'image.png',
      alt: 'Result',
      mimeType: 'image/png',
      path: fs.realpathSync.native(imagePath),
      workspaceId: 'ws-1',
      workspaceRelativePath: 'image.png',
      thumbnail: { dataBase64: 'thumb', mimeType: 'image/jpeg', width: 1, height: 1 },
      status: 'available'
    })
  })

  it('creates non-preview status refs for unsafe or outside markdown image paths', () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(workspace, 'diagram.svg'), '<svg><title>fixture</title></svg>')
    fs.writeFileSync(path.join(outside, 'secret.png'), PNG_BUFFER)

    const refs = createWorkspacePathMediaRefs({
      messageId: 'msg-1',
      workspacePath: workspace,
      content: ['![Vector](diagram.svg)', '![Outside](../outside/secret.png)'].join('\n'),
      thumbnailer: () => null
    })

    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({
      source: 'workspace_path',
      name: 'diagram.svg',
      alt: 'Vector',
      status: 'unsafe_svg',
      format: 'svg'
    })
    expect(refs[0].path).toBeUndefined()
    expect(refs[0].thumbnail).toBeUndefined()
    expect(refs[1]).toMatchObject({
      source: 'workspace_path',
      name: 'secret.png',
      alt: 'Outside',
      status: 'denied'
    })
    expect(refs[1].path).toBeUndefined()
    expect(refs[1].thumbnail).toBeUndefined()
  })

  it('creates generated media refs for provider image outputs', () => {
    const writes: Array<{ assetId: string; sha256: string; buffer: Buffer; mimeType: string }> = []
    const refs = createToolResultMediaRefs({
      messageId: 'msg-1',
      runId: 'run-1',
      source: 'generated',
      namePrefix: 'Provider image',
      blocks: [{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }],
      thumbnailer: () => null,
      assetWriter: (input) => {
        writes.push({
          assetId: input.assetId,
          sha256: input.sha256,
          buffer: input.buffer,
          mimeType: input.mimeType
        })
      }
    })

    expect(refs[0]).toMatchObject({
      source: 'generated',
      name: 'Provider image',
      assetId: expect.stringContaining('run:run-1:generated-image:')
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      assetId: refs[0].assetId,
      sha256: refs[0].sha256,
      mimeType: 'image/png'
    })
    expect(writes[0].buffer.equals(PNG_BUFFER)).toBe(true)
  })

  it('uses a small safe raster block as its own bounded thumbnail when native thumbnailing is absent', () => {
    const refs = createToolResultMediaRefs({
      messageId: 'msg-1',
      blocks: [{ type: 'image', mimeType: 'image/png', data: PNG_1X1_BASE64 }],
      thumbnailer: () => null
    })

    expect(refs[0].thumbnail).toEqual({
      dataBase64: PNG_BUFFER.toString('base64'),
      mimeType: 'image/png'
    })
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
    const canonicalExternal = fs.realpathSync.native(external)
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
          path: canonicalExternal,
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
            path: canonicalExternal,
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

  it('anchors external media authority to the signed path and signed filesystem kind', () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const external = path.join(root, 'external')
    const redirected = path.join(root, 'redirected')
    const symlinkGrantPath = path.join(root, 'signed-directory')
    fs.mkdirSync(workspace)
    fs.mkdirSync(external)
    fs.mkdirSync(redirected)
    const canonicalRoot = fs.realpathSync.native(root)
    const exactFile = path.join(external, 'exact.png')
    const siblingFile = path.join(external, 'sibling.png')
    const redirectedFile = path.join(redirected, 'secret.png')
    fs.writeFileSync(exactFile, PNG_BUFFER)
    fs.writeFileSync(siblingFile, PNG_BUFFER)
    fs.writeFileSync(redirectedFile, PNG_BUFFER)
    fs.symlinkSync(redirected, symlinkGrantPath, 'dir')

    const fileGrant = {
      id: 'file-grant',
      provider: 'codex' as const,
      path: path.join(canonicalRoot, 'external', 'exact.png'),
      kind: 'file' as const,
      access: 'read' as const,
      duration: 'thisRun' as const,
      createdAt: new Date().toISOString()
    }
    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: exactFile,
        externalPathGrants: [fileGrant]
      }).ok
    ).toBe(true)
    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: siblingFile,
        externalPathGrants: [fileGrant]
      })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })

    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: path.join(symlinkGrantPath, 'secret.png'),
        externalPathGrants: [
          {
            ...fileGrant,
            id: 'directory-grant',
            path: path.join(canonicalRoot, 'signed-directory'),
            kind: 'directory'
          }
        ]
      })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })

    expect(
      validateWorkspaceImagePath({
        workspacePath: workspace,
        candidatePath: exactFile,
        externalPathGrants: [
          {
            ...fileGrant,
            id: 'wrong-kind-grant',
            kind: 'directory'
          }
        ]
      })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })
  })

  it('returns the exact nofollow descriptor bytes so image consumers never reopen the path', () => {
    const workspace = makeTempRoot()
    const imagePath = path.join(workspace, 'replaceable.png')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    const validation = validateWorkspaceImagePath({
      workspacePath: workspace,
      candidatePath: imagePath
    })
    expect(validation.ok).toBe(true)
    if (!validation.ok) return

    const replacement = Buffer.from('not an image after validation')
    fs.writeFileSync(imagePath, replacement)
    expect(validation.buffer.equals(PNG_BUFFER)).toBe(true)
    expect(validation.sha256).toBeTruthy()
    expect(fs.readFileSync(validation.realPath).equals(replacement)).toBe(true)
  })

  it('snapshots raster and PDF attachments from the verified descriptor for durable persistence', () => {
    const workspace = makeTempRoot()
    const imagePath = path.join(workspace, 'image.png')
    const pdfPath = path.join(workspace, 'spec.pdf')
    const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n')
    fs.writeFileSync(imagePath, PNG_BUFFER)
    fs.writeFileSync(pdfPath, pdf)

    const image = snapshotRasterOrPdfAttachment({
      workspacePath: workspace,
      candidatePath: imagePath
    })
    const document = snapshotRasterOrPdfAttachment({
      workspacePath: workspace,
      candidatePath: pdfPath
    })

    expect(image.ok && image.mimeType).toBe('image/png')
    expect(image.ok && image.buffer.equals(PNG_BUFFER)).toBe(true)
    expect(document.ok && document.mimeType).toBe('application/pdf')
    expect(document.ok && document.buffer.equals(pdf)).toBe(true)
    expect(document.ok && document.sha256).toMatch(/^[A-Za-z0-9_-]{32,96}$/)
  })

  it('requires workspace, grant, or exact main-owned picker authority before snapshotting', () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'selected.pdf')
    fs.mkdirSync(workspace)
    fs.writeFileSync(outside, '%PDF-1.7\nfixture\n%%EOF\n')

    expect(
      snapshotRasterOrPdfAttachment({ workspacePath: workspace, candidatePath: outside })
    ).toEqual({ ok: false, reason: 'outside_allowed_roots' })

    const selected = snapshotRasterOrPdfAttachment({
      candidatePath: outside,
      authorizedFilePaths: [outside]
    })
    expect(selected.ok && selected.mimeType).toBe('application/pdf')
  })

  it('keeps durable attachment bytes stable after the source path is replaced', () => {
    const workspace = makeTempRoot()
    const imagePath = path.join(workspace, 'replace-after-snapshot.png')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    const snapshot = snapshotRasterOrPdfAttachment({
      workspacePath: workspace,
      candidatePath: imagePath
    })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return

    fs.writeFileSync(imagePath, Buffer.from('%PDF-1.7\nreplacement\n'))
    expect(snapshot.buffer.equals(PNG_BUFFER)).toBe(true)
    expect(snapshot.mimeType).toBe('image/png')
  })

  it('stages a descriptor-backed media snapshot that survives source replacement', async () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const staging = path.join(root, 'main-owned-staging')
    fs.mkdirSync(workspace)
    const sourcePath = path.join(workspace, 'clip.webm')
    const source = Buffer.alloc(256, 0x5a)
    source.set([0x1a, 0x45, 0xdf, 0xa3], 0)
    fs.writeFileSync(sourcePath, source)

    const staged = await stageWorkspaceMediaSnapshot({
      workspacePath: workspace,
      candidatePath: sourcePath,
      stagingDirectory: staging,
      kind: 'audio_video'
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return

    fs.writeFileSync(sourcePath, Buffer.from('replacement'))
    expect(staged.sourceRealPath).toBe(fs.realpathSync.native(sourcePath))
    expect(fs.readFileSync(staged.realPath).equals(source)).toBe(true)
    expect(staged.mimeType).toBe('video/webm')
    expect(staged.cleanup()).toBe(true)
    expect(fs.existsSync(staged.realPath)).toBe(false)
    expect(staged.cleanup()).toBe(false)
  })

  it('yields while copying a multi-chunk descriptor snapshot', async () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const staging = path.join(root, 'main-owned-staging')
    fs.mkdirSync(workspace)
    const sourcePath = path.join(workspace, 'large-clip.webm')
    const source = Buffer.alloc(2 * 1024 * 1024 + 256, 0x5a)
    source.set([0x1a, 0x45, 0xdf, 0xa3], 0)
    fs.writeFileSync(sourcePath, source)

    let releaseCopy!: () => void
    let reportCopyPaused!: () => void
    const copyPaused = new Promise<void>((resolve) => {
      reportCopyPaused = resolve
    })
    const copyRelease = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    setWorkspaceMediaSnapshotTestHookForTests(async (stage) => {
      if (stage !== 'after_first_chunk') return
      reportCopyPaused()
      await copyRelease
    })

    let settled = false
    const pending = stageWorkspaceMediaSnapshot({
      workspacePath: workspace,
      candidatePath: sourcePath,
      stagingDirectory: staging,
      kind: 'audio_video'
    }).finally(() => {
      settled = true
    })

    await copyPaused
    expect(settled).toBe(false)
    releaseCopy()
    const staged = await pending
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    expect(fs.readFileSync(staged.realPath).equals(source)).toBe(true)
    expect(staged.cleanup()).toBe(true)
  })

  it('rejects an in-place source mutation during an async descriptor copy', async () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const staging = path.join(root, 'main-owned-staging')
    fs.mkdirSync(workspace)
    const sourcePath = path.join(workspace, 'changing-clip.webm')
    const source = Buffer.alloc(2 * 1024 * 1024 + 256, 0x5a)
    source.set([0x1a, 0x45, 0xdf, 0xa3], 0)
    fs.writeFileSync(sourcePath, source)
    setWorkspaceMediaSnapshotTestHookForTests((stage) => {
      if (stage === 'after_first_chunk') fs.appendFileSync(sourcePath, Buffer.from('changed'))
    })

    await expect(
      stageWorkspaceMediaSnapshot({
        workspacePath: workspace,
        candidatePath: sourcePath,
        stagingDirectory: staging,
        kind: 'audio_video'
      })
    ).resolves.toEqual({ ok: false, reason: 'snapshot_failed' })
    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('refuses a symlinked staging directory instead of creating a path a workspace can replace', async () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const attackerOwned = path.join(root, 'attacker-owned')
    const stagingLink = path.join(root, 'staging-link')
    fs.mkdirSync(workspace)
    fs.mkdirSync(attackerOwned)
    fs.symlinkSync(attackerOwned, stagingLink, 'dir')
    const imagePath = path.join(workspace, 'image.png')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    expect(
      await stageWorkspaceMediaSnapshot({
        workspacePath: workspace,
        candidatePath: imagePath,
        stagingDirectory: stagingLink,
        kind: 'image'
      })
    ).toEqual({ ok: false, reason: 'unsafe_staging_directory' })
    expect(fs.readdirSync(attackerOwned)).toEqual([])
  })

  it('refuses to stage snapshots inside the agent-writable workspace', async () => {
    const workspace = makeTempRoot()
    const imagePath = path.join(workspace, 'image.png')
    const stagingPath = path.join(workspace, '.media-staging')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    expect(
      await stageWorkspaceMediaSnapshot({
        workspacePath: workspace,
        candidatePath: imagePath,
        stagingDirectory: stagingPath,
        kind: 'image'
      })
    ).toEqual({ ok: false, reason: 'unsafe_staging_directory' })
    expect(fs.existsSync(stagingPath)).toBe(false)
  })

  it('cleanup refuses to unlink a replacement at the staged path', async () => {
    const root = makeTempRoot()
    const workspace = path.join(root, 'workspace')
    const staging = path.join(root, 'staging')
    fs.mkdirSync(workspace)
    const imagePath = path.join(workspace, 'image.png')
    fs.writeFileSync(imagePath, PNG_BUFFER)

    const staged = await stageWorkspaceMediaSnapshot({
      workspacePath: workspace,
      candidatePath: imagePath,
      stagingDirectory: staging,
      kind: 'image'
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return

    fs.unlinkSync(staged.realPath)
    const replacement = Buffer.from('attacker replacement')
    fs.writeFileSync(staged.realPath, replacement)
    expect(staged.cleanup()).toBe(false)
    expect(fs.readFileSync(staged.realPath).equals(replacement)).toBe(true)
  })
})
