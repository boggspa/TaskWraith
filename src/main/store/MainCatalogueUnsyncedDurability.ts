/**
 * The catalogue's publication writes, made without a sync and owed to no
 * barrier: a thread's head and the tickets of its operations, the two kinds of
 * file the catalogue hands its durability seam. Each is written to a temporary
 * file and renamed into place exactly as before, so a reader sees the old file
 * or the new one and never a part of either.
 *
 * Nothing pays for them later. The catalogue is an index of the thread's
 * sources: the history worker derives a thread's row again from them whenever
 * a power loss has left its head or tickets gone, older than the sources, or
 * without their bytes, and a row reads as ready only while it matches the
 * witness of every file the worker reads it from
 * (`unsyncedWritePowerLoss.catalogue.test.ts`). So no barrier syncs a
 * catalogue file, nor the heads' directory that every thread shares.
 *
 * A head is `<catalogue>/desktop/<thread>.json` and a ticket is
 * `<catalogue>/pending/desktop/<thread>/<operation>.json`. A file that is
 * neither is written the strict way: synced before its rename, and its
 * directory synced after it.
 *
 * Nothing here waits for anything and nothing fails later: a write either
 * fails where it is made, leaving no file behind, or it is done. The recovery
 * holds, the erasure fences and the resolved rows never come here; the
 * catalogue writes those itself, synced.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ThreadCatalogueDeferredDurability } from '../../host-shared/thread-catalogue/ThreadCatalogueDurability'
import { isSafeChatId } from '../ChatPath'

export interface MainCatalogueUnsyncedDurabilityOptions {
  /** The profile the catalogue publishes under. */
  profilePath: string
}

export interface MainCatalogueUnsyncedDurabilitySnapshot {
  /** Files put in place, the strict ones included. */
  writes: number
  /** Of those, the ones that are not a thread's head or ticket, written synced. */
  strictWrites: number
}

/** A directory sync that fails with one of these is not offered by the file system. */
const DIRECTORY_SYNC_NOT_OFFERED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])

export class MainCatalogueUnsyncedDurability implements ThreadCatalogueDeferredDurability {
  private readonly profilePath: string
  private readonly heads: string
  private readonly tickets: string
  private writes = 0
  private strictWrites = 0

  constructor(options: MainCatalogueUnsyncedDurabilityOptions) {
    this.profilePath = path.resolve(options.profilePath)
    const catalogue = path.join(this.profilePath, 'thread-catalogue-v1')
    this.heads = path.join(catalogue, 'desktop')
    this.tickets = path.join(catalogue, 'pending', 'desktop')
  }

  /** Whether the file at this path is a thread's head or one of its tickets. */
  private isPublication(filePath: string): boolean {
    const directory = path.dirname(filePath)
    const name = path.basename(filePath)
    if (!name.endsWith('.json')) return false
    const thread =
      directory === this.heads
        ? name.slice(0, -'.json'.length)
        : path.dirname(directory) === this.tickets
          ? path.basename(directory)
          : null
    return thread !== null && isSafeChatId(thread)
  }

  prepareDirectory(filePath: string): boolean {
    const target = path.resolve(filePath)
    if (!this.isPublication(target)) return false
    // The profile owner creates the root. Only rebuildable publication names
    // may disappear on a power loss; no directory here becomes barrier debt.
    if (!fs.existsSync(this.profilePath)) throw new Error('Thread catalogue profile is absent')
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    return true
  }

  write(filePath: string, text: string, beforeRename?: () => void, afterRename?: () => void): void {
    const target = path.resolve(filePath)
    const strict = !this.isPublication(target)
    const temporary = `${target}.tmp-${randomUUID()}`
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, text)
        if (strict) fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      beforeRename?.()
      fs.renameSync(temporary, target)
      this.writes += 1
      if (strict) {
        this.strictWrites += 1
        syncDirectory(path.dirname(target))
      }
      afterRename?.()
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  /** Nothing is pending here: a head or ticket is owed to nothing. */
  awaitDurable(): Promise<void> {
    return Promise.resolve()
  }

  snapshot(): MainCatalogueUnsyncedDurabilitySnapshot {
    return { writes: this.writes, strictWrites: this.strictWrites }
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    // Windows cannot open a directory to sync it; other systems may not offer the call.
    const unsupported =
      DIRECTORY_SYNC_NOT_OFFERED.has(code) ||
      (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code))
    if (!unsupported) throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
