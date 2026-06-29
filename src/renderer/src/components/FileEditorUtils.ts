export interface FileEditorContextMenuAnchor {
  x: number
  y: number
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
