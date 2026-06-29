export interface FileEditorContextMenuAnchor {
  x: number
  y: number
}

interface FileEditorContextMenuRect {
  left: number
  top: number
  width: number
  height: number
}

export const isFileEditorContextMenuKey = (key: string, shiftKey: boolean): boolean => {
  return key === 'ContextMenu' || (shiftKey && key === 'F10')
}

export const contextMenuAnchorFromRect = (
  rect: FileEditorContextMenuRect
): FileEditorContextMenuAnchor => {
  const xOffset = Math.max(0, Math.min(rect.width - 8, 28))
  const yOffset = Math.max(0, Math.min(rect.height - 4, 24))
  return {
    x: Math.round(rect.left + xOffset),
    y: Math.round(rect.top + yOffset)
  }
}

export const formatBytes = (value?: number): string => {
  if (!value) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export const fileNameForPath = (filePath: string): string => {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

export const parentDirectoryForPath = (filePath: string): string => {
  const parts = filePath.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}
