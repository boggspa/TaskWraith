import type { WorkspaceFileReadResult } from '../../../main/store/types'
import type { EditorCursorStatus } from './FileEditorStatusBar'

export interface EditorBuffer {
  path: string
  content: string
  savedContent: string
  savedEtag: string | null
  sizeBytes: number
  mtimeMs?: number
  cursorStatus?: EditorCursorStatus
  cursorSelection?: EditorBufferSelection
}

export interface EditorBufferSelection {
  anchor: number
  head: number
}

export const bufferFromReadResult = (result: WorkspaceFileReadResult): EditorBuffer => ({
  path: result.path,
  content: result.content,
  savedContent: result.content,
  savedEtag: result.etag ?? null,
  sizeBytes: result.sizeBytes,
  mtimeMs: result.mtimeMs
})

export const isBufferDirty = (buffer: EditorBuffer | null | undefined): boolean => {
  return Boolean(buffer && buffer.content !== buffer.savedContent)
}

export const mergeSavedBufferResult = (
  currentBuffer: EditorBuffer,
  nextSavedBuffer: EditorBuffer,
  savedContentSnapshot: string,
  savedEtagSnapshot: string | null
): EditorBuffer => {
  if (currentBuffer.savedEtag !== savedEtagSnapshot) return currentBuffer
  if (currentBuffer.content === savedContentSnapshot) {
    return {
      ...nextSavedBuffer,
      cursorSelection: currentBuffer.cursorSelection,
      cursorStatus: currentBuffer.cursorStatus
    }
  }
  return {
    ...currentBuffer,
    savedContent: nextSavedBuffer.savedContent,
    savedEtag: nextSavedBuffer.savedEtag,
    sizeBytes: nextSavedBuffer.sizeBytes,
    mtimeMs: nextSavedBuffer.mtimeMs
  }
}

export const updateBuffer = (
  buffers: EditorBuffer[],
  path: string,
  updater: (buffer: EditorBuffer) => EditorBuffer
): EditorBuffer[] => {
  return buffers.map((buffer) => (buffer.path === path ? updater(buffer) : buffer))
}

export const upsertBuffer = (buffers: EditorBuffer[], nextBuffer: EditorBuffer): EditorBuffer[] => {
  const index = buffers.findIndex((buffer) => buffer.path === nextBuffer.path)
  if (index < 0) return [...buffers, nextBuffer]
  const next = [...buffers]
  next[index] = nextBuffer
  return next
}

export const closeBuffer = (
  buffers: EditorBuffer[],
  path: string
): { buffers: EditorBuffer[]; nextSelectedPath: string } => {
  const index = buffers.findIndex((buffer) => buffer.path === path)
  if (index < 0) return { buffers, nextSelectedPath: buffers[0]?.path ?? '' }
  const nextBuffers = buffers.filter((buffer) => buffer.path !== path)
  const nextSelectedPath =
    nextBuffers[Math.min(index, nextBuffers.length - 1)]?.path ?? nextBuffers[0]?.path ?? ''
  return { buffers: nextBuffers, nextSelectedPath }
}
