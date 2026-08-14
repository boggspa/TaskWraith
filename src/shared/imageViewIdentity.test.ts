import { describe, expect, it } from 'vitest'
import {
  canonicalImageViewToolName,
  imageViewCountFromResult,
  isImageViewToolUse,
  resolveImageViewCount
} from './imageViewIdentity'

describe('image view activity identity', () => {
  it('coalesces provider-native viewer aliases and namespaced broker calls', () => {
    expect(canonicalImageViewToolName('view_image')).toBe('image_view')
    expect(canonicalImageViewToolName('mcp__TaskWraith__image_view')).toBe('image_view')
    expect(canonicalImageViewToolName('InspectImage')).toBe('image_view')
  })

  it('coalesces screenshot-producing tools while leaving status calls distinct', () => {
    expect(canonicalImageViewToolName('appshots')).toBe('image_view')
    expect(canonicalImageViewToolName('appwatch_frames')).toBe('image_view')
    expect(canonicalImageViewToolName('canvas_screenshot')).toBe('image_view')
    expect(canonicalImageViewToolName('appshots_status')).toBe('appshots_status')
  })

  it('recognizes a generic file read only when it points at raster media', () => {
    expect(canonicalImageViewToolName('read_file', { path: 'evidence/final.png' })).toBe(
      'image_view'
    )
    expect(canonicalImageViewToolName('read_file', { path: 'src/index.ts' })).toBe('read_file')
  })

  it('recognizes Codex exec wrappers that invoke the native viewer', () => {
    const code = `const paths = ["/tmp/a.png", "/tmp/b.png"]; for (const path of paths) await tools.view_image({ path });`
    expect(isImageViewToolUse('exec', { code })).toBe(true)
    expect(resolveImageViewCount({ code })).toBe(2)
  })

  it('prefers the number of returned image blocks over a requested count', () => {
    const result = {
      content: [
        { type: 'text', text: '{}' },
        { type: 'image', mimeType: 'image/png', data: 'one' },
        { type: 'image', mimeType: 'image/png', data: 'two' }
      ]
    }
    expect(imageViewCountFromResult(result)).toBe(2)
    expect(resolveImageViewCount({ count: 4 }, result)).toBe(2)
  })

  it('does not double-count providers that mirror one envelope in result and content', () => {
    const content = [{ type: 'image', mimeType: 'image/png', data: 'same' }]
    expect(imageViewCountFromResult({ content, result: { content } })).toBe(1)
  })

  it('counts batch source paths and media ids', () => {
    expect(
      resolveImageViewCount({ paths: ['one.png', 'two.jpg'], sourceMediaIds: ['media-1'] })
    ).toBe(3)
  })
})
