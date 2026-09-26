/**
 * The Host's clean-exit marker (Independent Threads M4, slice 14b; SF-1).
 *
 * A clean shutdown writes it durably as its last step; the next boot
 * consumes it durably before anything else can write. A boot that finds none
 * follows an unclean exit: with the transactional persist on, recovery then
 * resets the generation once (decision 2), because writers without a
 * manifest (deletes, run-port and Domain writes) can crash between their
 * record and their group just as a persist can. A false positive (a
 * force-quit after a finished drain that never wrote the marker) costs one
 * snapshot per connected client and nothing else.
 */
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

export const HOST_CLEAN_EXIT_FILENAME = 'host-clean-exit.json'

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Write the marker durably: a temp file, fsynced, renamed, then the directory. */
export function recordHostCleanExit(runtimePath: string, now: () => number = Date.now): void {
  const path = join(runtimePath, HOST_CLEAN_EXIT_FILENAME)
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify({ cleanAt: now(), pid: process.pid })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  syncDirectory(runtimePath)
}

/**
 * Whether the last exit was clean. The marker is removed durably first, so a
 * crash later in this incarnation reads unclean at the next boot. Anything
 * but a marker file that was removed reads unclean.
 */
export function consumeHostCleanExit(runtimePath: string): boolean {
  const path = join(runtimePath, HOST_CLEAN_EXIT_FILENAME)
  try {
    if (!lstatSync(path).isFile()) return false
    unlinkSync(path)
    syncDirectory(runtimePath)
    return true
  } catch {
    return false
  }
}
