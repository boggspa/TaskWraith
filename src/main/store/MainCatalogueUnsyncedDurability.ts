/**
 * The catalogue's publication writes, made without a sync: a thread's head
 * and the tickets of its operations, the two kinds of file the catalogue hands
 * its durability seam. Each is written to a temporary file and renamed into
 * place exactly as before, so a reader sees the old file or the new one and
 * never a part of either. What the disk is owed for it, the file and the
 * directory that gained its name, is noted against the thread the file is
 * about, for that thread's barrier to pay.
 *
 * The thread is read from where the file lives: a head is
 * `<catalogue>/desktop/<thread>.json` and a ticket is
 * `<catalogue>/pending/desktop/<thread>/<operation>.json`. A file that is
 * neither cannot be owed to any barrier, so it is written the strict way:
 * synced before its rename, and its directory synced after it.
 *
 * Nothing here waits for anything and nothing fails later: a write either
 * fails where it is made, leaving no file and no debt behind, or it is done.
 * The recovery holds, the erasure fences and the resolved rows never come
 * here; the catalogue writes those itself, synced.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ThreadCatalogueDeferredDurability } from '../../host-shared/thread-catalogue/ThreadCatalogueDurability'
import { isSafeChatId } from '../ChatPath'
import type { NoteThreadDurabilityDebt } from './ThreadDurabilityDebt'

export interface MainCatalogueUnsyncedDurabilityOptions {
  /** The profile the catalogue publishes under. */
  profilePath: string
  note: NoteThreadDurabilityDebt
}

export interface MainCatalogueUnsyncedDurabilitySnapshot {
  /** Files put in place, the strict ones included. */
  writes: number
  /** Of those, the ones no thread could be found for, written synced. */
  strictWrites: number
}

/** A directory sync that fails with one of these is not offered by the file system. */
const DIRECTORY_SYNC_NOT_OFFERED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])

export class MainCatalogueUnsyncedDurability implements ThreadCatalogueDeferredDurability {
  private readonly heads: string
  private readonly tickets: string
  private writes = 0
  private strictWrites = 0

  constructor(private readonly options: MainCatalogueUnsyncedDurabilityOptions) {
    const catalogue = path.join(path.resolve(options.profilePath), 'thread-catalogue-v1')
    this.heads = path.join(catalogue, 'desktop')
    this.tickets = path.join(catalogue, 'pending', 'desktop')
  }

  /** The thread a head or ticket at this path is about, or null for any other file. */
  private threadOf(filePath: string): string | null {
    const directory = path.dirname(filePath)
    const name = path.basename(filePath)
    if (!name.endsWith('.json')) return null
    const thread =
      directory === this.heads
        ? name.slice(0, -'.json'.length)
        : path.dirname(directory) === this.tickets
          ? path.basename(directory)
          : null
    return thread !== null && isSafeChatId(thread) ? thread : null
  }

  write(filePath: string, text: string, beforeRename?: () => void, afterRename?: () => void): void {
    const target = path.resolve(filePath)
    const thread = this.threadOf(target)
    const directory = path.dirname(target)
    const temporary = `${target}.tmp-${randomUUID()}`
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, text)
        if (thread === null) fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      beforeRename?.()
      fs.renameSync(temporary, target)
      this.writes += 1
      if (thread === null) {
        this.strictWrites += 1
        syncDirectory(directory)
      } else {
        // Owed before any caller's callback runs: a callback that throws must
        // not leave visible bytes that no barrier will pay.
        this.options.note(thread, { file: target, owner: 'catalogue' })
        this.options.note(thread, { directory })
      }
      afterRename?.()
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  /** Nothing is pending here: what a write owes belongs to its thread's barrier. */
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
