import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Retire only the exact host-authored projection. Recovery records are separate. */
export function retireSharedWorkspaceIntent(
  marker: string,
  contents: string,
  archiveDirectory: string
): boolean {
  try {
    const stat = lstatSync(marker)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return false
    if (readFileSync(marker, 'utf8') !== contents) return false
    mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
    const digest = createHash('sha256').update(contents).digest('hex')
    const archive = join(archiveDirectory, `${digest}.md`)
    if (existsSync(archive)) {
      if (lstatSync(archive).isSymbolicLink() || readFileSync(archive, 'utf8') !== contents)
        return false
    } else writeFileSync(archive, contents, { flag: 'wx', mode: 0o600 })
    // Capture the current inode; a renewal racing the read is preserved and
    // restored without overwriting a newer marker at the original path.
    const captured = join(archiveDirectory, `captured-${randomUUID()}.md`)
    renameSync(marker, captured)
    if (lstatSync(captured).isSymbolicLink() || readFileSync(captured, 'utf8') !== contents) {
      try {
        linkSync(captured, marker)
      } catch {
        // The captured file remains recoverable, including if a newer marker exists.
      }
      return false
    }
    unlinkSync(captured)
    return true
  } catch {
    // Cleanup failure cannot fail an edit or extend its authority.
    return false
  }
}

/** Renewals replace their timer; an exited host is handled by the maintenance report. */
export function armSharedWorkspaceIntentExpiry(
  marker: string,
  contents: string,
  archiveDirectory: string,
  expiresAt: number
): void {
  const previous = timers.get(marker)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(
    () => {
      if (timers.get(marker) !== timer) return
      timers.delete(marker)
      if (Date.now() <= expiresAt) {
        armSharedWorkspaceIntentExpiry(marker, contents, archiveDirectory, expiresAt)
        return
      }
      retireSharedWorkspaceIntent(marker, contents, archiveDirectory)
    },
    Math.max(1, expiresAt - Date.now() + 1)
  )
  timer.unref()
  timers.set(marker, timer)
}
