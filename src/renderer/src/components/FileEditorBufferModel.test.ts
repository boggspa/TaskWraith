import { describe, expect, it } from 'vitest'
import {
  bufferFromReadResult,
  closeBuffer,
  isBufferDirty,
  mergeSavedBufferResult,
  updateBuffer,
  upsertBuffer,
  type EditorBuffer
} from './FileEditorBufferModel'

const buffer = (overrides: Partial<EditorBuffer> = {}): EditorBuffer => ({
  path: 'src/App.tsx',
  content: 'saved',
  savedContent: 'saved',
  savedEtag: 'etag-1',
  sizeBytes: 5,
  ...overrides
})

describe('FileEditorBufferModel', () => {
  it('creates a clean editor buffer from a file read result', () => {
    expect(
      bufferFromReadResult({
        path: 'src/App.tsx',
        content: 'hello',
        sizeBytes: 5,
        etag: 'etag-1',
        mtimeMs: 123
      })
    ).toEqual({
      path: 'src/App.tsx',
      content: 'hello',
      savedContent: 'hello',
      savedEtag: 'etag-1',
      sizeBytes: 5,
      mtimeMs: 123
    })
  })

  it('identifies dirty buffers by comparing content with saved content', () => {
    expect(isBufferDirty(buffer())).toBe(false)
    expect(isBufferDirty(buffer({ content: 'draft' }))).toBe(true)
    expect(isBufferDirty(null)).toBe(false)
  })

  it('replaces a clean buffer with the latest saved result', () => {
    const nextSaved = buffer({
      content: 'saved on disk',
      savedContent: 'saved on disk',
      savedEtag: 'etag-2',
      sizeBytes: 13
    })

    expect(mergeSavedBufferResult(buffer(), nextSaved, 'saved', 'etag-1')).toBe(nextSaved)
  })

  it('preserves dirty content while refreshing the saved baseline', () => {
    const current = buffer({ content: 'draft' })
    const nextSaved = buffer({
      content: 'saved on disk',
      savedContent: 'saved on disk',
      savedEtag: 'etag-2',
      sizeBytes: 13,
      mtimeMs: 456
    })

    expect(mergeSavedBufferResult(current, nextSaved, 'saved', 'etag-1')).toEqual({
      ...current,
      savedContent: 'saved on disk',
      savedEtag: 'etag-2',
      sizeBytes: 13,
      mtimeMs: 456
    })
  })

  it('keeps the current buffer when the save baseline changed mid-flight', () => {
    const current = buffer({ savedEtag: 'etag-newer', content: 'draft' })
    const nextSaved = buffer({ savedEtag: 'etag-2', content: 'saved on disk' })

    expect(mergeSavedBufferResult(current, nextSaved, 'saved', 'etag-1')).toBe(current)
  })

  it('updates or inserts buffers by path', () => {
    const first = buffer({ path: 'a.ts', content: 'a', savedContent: 'a' })
    const second = buffer({ path: 'b.ts', content: 'b', savedContent: 'b' })
    const updated = buffer({ path: 'a.ts', content: 'draft', savedContent: 'a' })

    expect(updateBuffer([first, second], 'a.ts', () => updated)).toEqual([updated, second])
    expect(upsertBuffer([first], updated)).toEqual([updated])
    expect(upsertBuffer([first], second)).toEqual([first, second])
  })

  it('selects the next neighboring tab when closing buffers', () => {
    const first = buffer({ path: 'a.ts' })
    const second = buffer({ path: 'b.ts' })
    const third = buffer({ path: 'c.ts' })

    expect(closeBuffer([first, second, third], 'b.ts')).toEqual({
      buffers: [first, third],
      nextSelectedPath: 'c.ts'
    })
    expect(closeBuffer([first, second, third], 'c.ts')).toEqual({
      buffers: [first, second],
      nextSelectedPath: 'b.ts'
    })
    expect(closeBuffer([first], 'a.ts')).toEqual({
      buffers: [],
      nextSelectedPath: ''
    })
  })
})
