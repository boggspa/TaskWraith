import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from './services/TranscriptMediaAssetStore'

export interface RemoteImageAttachmentInput {
  dataBase64: string
  mimeType: string
}

export interface PersistedRemoteImageAttachment {
  path: string
  mimeType: 'image/png' | 'image/jpeg'
  buffer: Buffer
}

type RemoteAttachmentAssetStore = Pick<TranscriptMediaAssetStore, 'writeOwnedMany'>

const MAX_REMOTE_IMAGE_ATTACHMENTS = 20
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const LEGACY_REMOTE_ATTACHMENT_PATTERN =
  /^[A-Za-z0-9-]+(?:-steer)?-[1-9]\d*-[0-9]+\.(?:png|jpg)$/

function sameIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertCurrentUserOwned(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user.`)
  }
}

function canonicalMimeType(value: string): 'image/png' | 'image/jpeg' | null {
  if (value === 'image/png') return value
  if (value === 'image/jpeg' || value === 'image/jpg') return 'image/jpeg'
  return null
}

function decodeCanonicalBase64(value: string): Buffer {
  const normalized = value.trim().replace(/\s+/g, '')
  if (!normalized || !BASE64_PATTERN.test(normalized)) {
    throw new Error('Remote image attachment is not canonical base64.')
  }
  const buffer = Buffer.from(normalized, 'base64')
  if (
    buffer.length <= 0 ||
    buffer.length > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES ||
    buffer.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')
  ) {
    throw new Error('Remote image attachment exceeds the safe image boundary.')
  }
  return buffer
}

/**
 * Persist phone/remote image input in the same chat-owned content-addressed
 * store as transcript media. This replaces anonymous OS-temp staging: the
 * bytes and ownership grant publish atomically, participate in the
 * transaction-long media history fence, and are removed by the exact chat or
 * global history purge. User-selected source files are never inputs here.
 */
export function persistRemoteImageAttachments(input: {
  appChatId: string
  attachments: readonly RemoteImageAttachmentInput[]
  store: RemoteAttachmentAssetStore
}): PersistedRemoteImageAttachment[] {
  const appChatId = input.appChatId.trim()
  if (!appChatId) throw new Error('Remote image attachment requires a canonical chat id.')
  if (input.attachments.length > MAX_REMOTE_IMAGE_ATTACHMENTS) {
    throw new Error('Remote image attachment count exceeds the safe boundary.')
  }

  const decoded = input.attachments.map((attachment) => {
    const mimeType = canonicalMimeType(attachment.mimeType)
    if (!mimeType) throw new Error('Remote image attachment type is unsupported.')
    const buffer = decodeCanonicalBase64(attachment.dataBase64)
    return {
      mimeType,
      buffer,
      sha256: createHash('sha256').update(buffer).digest('base64url')
    }
  })
  if (decoded.length === 0) return []

  const written = input.store.writeOwnedMany(
    decoded.map((attachment) => ({
      sha256: attachment.sha256,
      mimeType: attachment.mimeType,
      buffer: attachment.buffer,
      appChatId
    }))
  )
  if (!written.ok) {
    throw new Error(`Remote image attachment persistence failed: ${written.reason}.`)
  }
  if (written.assets.length !== decoded.length) {
    throw new Error('Remote image attachment persistence returned an incomplete batch.')
  }
  return written.assets.map((asset, index) => ({
    path: asset.path,
    mimeType: decoded[index].mimeType,
    buffer: decoded[index].buffer
  }))
}

/**
 * Remove only files created by the retired anonymous phone-staging path. New
 * attachments never enter this directory. Any unknown entry, link, directory
 * substitution, or ownership mismatch fails closed instead of risking a user
 * file. The caller may report the failure, but must not broaden the target.
 */
export function purgeLegacyRemoteAttachmentTempRoot(rootPath: string): number {
  let rootBefore: fs.Stats
  try {
    rootBefore = fs.lstatSync(rootPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error('Legacy remote attachment root is not a real directory.')
  }
  assertCurrentUserOwned(rootBefore, 'Legacy remote attachment root')

  const directoryFd = fs.openSync(
    rootPath,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
  )
  let deleted = 0
  try {
    const openedRoot = fs.fstatSync(directoryFd)
    if (!openedRoot.isDirectory() || !sameIdentity(rootBefore, openedRoot)) {
      throw new Error('Legacy remote attachment root changed while it was opened.')
    }
    for (const entry of fs.readdirSync(rootPath).sort()) {
      if (!LEGACY_REMOTE_ATTACHMENT_PATTERN.test(entry)) {
        throw new Error('Legacy remote attachment root contains an unknown entry.')
      }
      const filePath = path.join(rootPath, entry)
      const before = fs.lstatSync(filePath)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('Legacy remote attachment entry is not an unlink-safe file.')
      }
      assertCurrentUserOwned(before, 'Legacy remote attachment entry')
      const fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
      )
      try {
        const opened = fs.fstatSync(fd)
        const currentRoot = fs.lstatSync(rootPath)
        const currentPath = fs.lstatSync(filePath)
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          !sameIdentity(before, opened) ||
          !sameIdentity(opened, currentPath) ||
          !sameIdentity(openedRoot, currentRoot)
        ) {
          throw new Error('Legacy remote attachment entry changed before deletion.')
        }
        fs.unlinkSync(filePath)
        try {
          fs.lstatSync(filePath)
          throw new Error('Legacy remote attachment entry survived deletion.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        deleted += 1
      } finally {
        fs.closeSync(fd)
      }
    }
    fs.fsyncSync(directoryFd)
    const finalRoot = fs.lstatSync(rootPath)
    if (!sameIdentity(openedRoot, finalRoot)) {
      throw new Error('Legacy remote attachment root changed during deletion.')
    }
  } finally {
    fs.closeSync(directoryFd)
  }
  return deleted
}
