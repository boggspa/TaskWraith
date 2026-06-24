import { describe, expect, it } from 'vitest'
import {
  inlineMarkdownImageThumbnail,
  posixNormalize,
  resolveInlineMarkdownImage,
  resolveMarkdownImageRef
} from './resolveMarkdownImageRef'
import type { ChatMediaRef } from '../components/ChatMediaPanel'

const PNG_THUMB = { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }

function imageRef(overrides: Partial<ChatMediaRef>): ChatMediaRef {
  return {
    id: overrides.id || 'ref-1',
    kind: 'image',
    source: overrides.source || 'workspace_path',
    name: overrides.name || 'out.png',
    path: overrides.path ?? '/Users/me/ws/out.png',
    status: overrides.status ?? 'available',
    thumbnail: 'thumbnail' in overrides ? overrides.thumbnail : PNG_THUMB,
    ...overrides
  }
}

describe('posixNormalize', () => {
  it('collapses ./, ../, // and trailing slashes', () => {
    expect(posixNormalize('./a/b')).toBe('a/b')
    expect(posixNormalize('a//b/../c')).toBe('a/c')
    expect(posixNormalize('/x/./y/')).toBe('/x/y')
    expect(posixNormalize('/x/../../y')).toBe('/y')
  })
  it('converts backslashes (Windows-tolerant)', () => {
    expect(posixNormalize('a\\b\\c')).toBe('a/b/c')
  })
})

describe('resolveMarkdownImageRef — matching', () => {
  it('matches a relative src to workspaceRelativePath WITHOUT a workspace path', () => {
    const ref = imageRef({ workspaceRelativePath: 'out.png' })
    expect(resolveMarkdownImageRef('out.png', [ref])).toBe(ref)
    expect(resolveMarkdownImageRef('./out.png', [ref])).toBe(ref)
  })

  it('matches a nested relative src to a nested workspaceRelativePath', () => {
    const ref = imageRef({ path: '/Users/me/ws/sub/img.png', workspaceRelativePath: 'sub/img.png' })
    expect(resolveMarkdownImageRef('sub/img.png', [ref])).toBe(ref)
    expect(resolveMarkdownImageRef('./sub/../sub/img.png', [ref])).toBe(ref)
  })

  it('matches a relative src by absolute path when workspacePath is given', () => {
    const ref = imageRef({ path: '/Users/me/ws/out.png' }) // no workspaceRelativePath
    expect(resolveMarkdownImageRef('out.png', [ref], '/Users/me/ws')).toBe(ref)
  })

  it('matches an absolute src to ref.path', () => {
    const ref = imageRef({ path: '/Users/me/ws/out.png' })
    expect(resolveMarkdownImageRef('/Users/me/ws/out.png', [ref])).toBe(ref)
  })

  it('decodes and matches a file:// src', () => {
    const ref = imageRef({ path: '/Users/me/ws/my out.png' })
    expect(resolveMarkdownImageRef('file:///Users/me/ws/my%20out.png', [ref])).toBe(ref)
  })

  it('does not match a different path', () => {
    const ref = imageRef({ path: '/Users/me/ws/out.png', workspaceRelativePath: 'out.png' })
    expect(resolveMarkdownImageRef('other.png', [ref])).toBeUndefined()
    expect(resolveMarkdownImageRef('/elsewhere/out.png', [ref])).toBeUndefined()
  })

  it('does NOT match by basename alone (anti-spoof)', () => {
    // A ref for ws/out.png must not be borrowed by `![](evil/out.png)`.
    const ref = imageRef({ path: '/Users/me/ws/out.png', workspaceRelativePath: 'out.png' })
    expect(resolveMarkdownImageRef('evil/out.png', [ref], '/Users/me/ws')).toBeUndefined()
  })
})

describe('resolveMarkdownImageRef — rejections', () => {
  it('rejects remote / non-local schemes', () => {
    const ref = imageRef({ path: 'https://example.com/x.png' })
    expect(resolveMarkdownImageRef('https://example.com/x.png', [ref])).toBeUndefined()
    expect(resolveMarkdownImageRef('http://x/y.png', [ref])).toBeUndefined()
    expect(resolveMarkdownImageRef('data:image/png;base64,AAAA', [ref])).toBeUndefined()
    expect(resolveMarkdownImageRef('javascript:alert(1)', [ref])).toBeUndefined()
  })

  it('skips refs without a filesystem path', () => {
    const ref = imageRef({ path: '', thumbnail: PNG_THUMB })
    expect(resolveMarkdownImageRef('out.png', [ref])).toBeUndefined()
  })

  it('returns undefined for empty inputs', () => {
    expect(resolveMarkdownImageRef('', [imageRef({})])).toBeUndefined()
    expect(resolveMarkdownImageRef('out.png', [])).toBeUndefined()
    expect(resolveMarkdownImageRef('out.png', undefined)).toBeUndefined()
  })

  it('ignores non-image refs', () => {
    const fileRef: ChatMediaRef = {
      id: 'f',
      kind: 'file',
      source: 'upload',
      name: 'out.png',
      path: '/Users/me/ws/out.png',
      workspaceRelativePath: 'out.png'
    }
    expect(resolveMarkdownImageRef('out.png', [fileRef])).toBeUndefined()
  })
})

describe('inlineMarkdownImageThumbnail', () => {
  it('emits a data: URL for a raster thumbnail', () => {
    expect(inlineMarkdownImageThumbnail(imageRef({}))).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    )
  })
  it('returns empty when there is no thumbnail', () => {
    expect(inlineMarkdownImageThumbnail(imageRef({ thumbnail: undefined }))).toBe('')
  })
  it('returns empty for a non-raster thumbnail mime', () => {
    const ref = imageRef({ thumbnail: { dataBase64: 'PHN2Zz4=', mimeType: 'image/svg+xml' } })
    expect(inlineMarkdownImageThumbnail(ref)).toBe('')
  })
})

describe('resolveInlineMarkdownImage — the render gate (H4)', () => {
  it('returns the ref + data: thumbnail for an available raster image', () => {
    const ref = imageRef({ workspaceRelativePath: 'out.png' })
    const out = resolveInlineMarkdownImage('out.png', [ref])
    expect(out?.ref).toBe(ref)
    expect(out?.thumbnail.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('renders a legacy upload ref with no status but a data thumbnail', () => {
    // Uploaded attachments predate the status field — the user attaching their
    // own image inline is point #1's primary case and must still show.
    const ref = imageRef({ source: 'upload', workspaceRelativePath: 'out.png', status: undefined })
    const out = resolveInlineMarkdownImage('out.png', [ref])
    expect(out?.ref).toBe(ref)
    expect(out?.thumbnail.startsWith('data:')).toBe(true)
  })

  it('returns null when the ref is not available (missing / denied)', () => {
    const ref = imageRef({ workspaceRelativePath: 'out.png', status: 'missing', thumbnail: undefined })
    expect(resolveInlineMarkdownImage('out.png', [ref])).toBeNull()
  })

  it('SECURITY: returns null for an SVG ref even if the path matches', () => {
    const ref = imageRef({
      workspaceRelativePath: 'diagram.svg',
      path: '/Users/me/ws/diagram.svg',
      status: 'unsafe_svg',
      thumbnail: undefined
    })
    expect(resolveInlineMarkdownImage('diagram.svg', [ref])).toBeNull()
  })

  it('returns null when a matched ref has no data thumbnail', () => {
    const ref = imageRef({ workspaceRelativePath: 'out.png', thumbnail: undefined })
    expect(resolveInlineMarkdownImage('out.png', [ref])).toBeNull()
  })

  it('SECURITY: never resolves a remote src to any thumbnail', () => {
    const ref = imageRef({ path: 'https://example.com/x.png', workspaceRelativePath: undefined })
    expect(resolveInlineMarkdownImage('https://example.com/x.png', [ref])).toBeNull()
  })
})
