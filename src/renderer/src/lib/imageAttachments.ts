import {
  localPathToFileUrl,
  pathBasename,
  pathComparisonKey,
  sanitizeLocalPath
} from './pathDisplay'

export type ImageAttachment = {
  id: string
  path: string
  name: string
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff|tif|svg|jfif)(\?.*)?$/i
const PDF_EXT = /\.pdf(?:[?#].*)?$/i
export const MAX_IMAGE_ATTACHMENTS = 15

export const sanitizeImagePath = (value: string): string =>
  sanitizeLocalPath(value)

export const getImageName = (value: string): string => {
  return pathBasename(value)
}

export const isImageAttachmentPath = (path: string): boolean => IMAGE_EXT.test(path)

export const isPdfAttachmentPath = (path: string): boolean => PDF_EXT.test(path)

export const dedupePaths = (values: string[]): string[] => {
  const seen = new Set<string>()
  const next: string[] = []
  for (const item of values) {
    const normalized = sanitizeImagePath(item)
    const key = pathComparisonKey(normalized)
    if (!normalized || seen.has(key)) {
      continue
    }
    seen.add(key)
    next.push(normalized)
  }
  return next
}

export const collectClipboardAttachmentPaths = (
  clipboardData?: DataTransfer | null
): string[] => {
  if (!clipboardData) {
    return []
  }

  const paths: string[] = []
  const fileList = clipboardData.files
  for (let i = 0; i < fileList.length; i += 1) {
    const file = fileList.item(i)
    if (!file) continue
    const asFile = file as File & { path?: string }
    const candidate = sanitizeImagePath(asFile.path || file.name)
    if (candidate) {
      paths.push(candidate)
    }
  }

  if (paths.length > 0) {
    return dedupePaths(paths)
  }

  const uriList = clipboardData.getData('text/uri-list')
  if (uriList) {
    const uriCandidates = uriList
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith('file://'))
      .map((line) => sanitizeImagePath(line))
      .filter(Boolean)
    if (uriCandidates.length > 0) {
      return dedupePaths(uriCandidates)
    }
  }

  for (let i = 0; i < clipboardData.items.length; i += 1) {
    const item = clipboardData.items[i]
    if (item.kind !== 'file' || !item.type.startsWith('image/')) {
      continue
    }
    const file = item.getAsFile()
    if (!file) continue
    const asFile = file as File & { path?: string }
    const candidate = sanitizeImagePath(asFile.path || file.name)
    if (candidate) {
      paths.push(candidate)
    }
  }

  return dedupePaths(paths)
}

export const collectDroppedAttachmentPaths = (dataTransfer?: DataTransfer | null): string[] => {
  if (!dataTransfer) {
    return []
  }
  const paths: string[] = []

  const fileList = dataTransfer.files
  for (let i = 0; i < fileList.length; i += 1) {
    const file = fileList.item(i)
    if (!file) continue
    const asFile = file as File & { path?: string }
    const candidate = sanitizeImagePath(asFile.path || file.name)
    if (candidate) {
      paths.push(candidate)
    }
  }

  if (paths.length > 0) {
    return dedupePaths(paths)
  }

  const uriList = dataTransfer.getData('text/uri-list')
  if (!uriList) {
    return []
  }

  const uriCandidates = uriList
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('file://'))
    .map((line) => sanitizeImagePath(line))
    .filter(Boolean)

  return dedupePaths(uriCandidates)
}

export const getImagePreviewSrc = (imagePath: string): string => {
  return localPathToFileUrl(imagePath)
}

const dedupeAttachments = (incoming: ImageAttachment[]): ImageAttachment[] => {
  const seen = new Set<string>()
  const next: ImageAttachment[] = []
  for (const item of incoming) {
    const key = pathComparisonKey(item.path)
    if (!seen.has(key)) {
      seen.add(key)
      next.push(item)
    }
  }
  return next
}

export const mergeImageAttachments = (
  current: ImageAttachment[],
  additions: ImageAttachment[]
): ImageAttachment[] => {
  return dedupeAttachments([...current, ...additions]).slice(-MAX_IMAGE_ATTACHMENTS)
}
