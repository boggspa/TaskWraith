import { statSync } from 'node:fs'
import { lstat, open, rename, stat, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

type DirectoryStat = { isDirectory(): boolean }
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

/** Call after ENOENT: Windows can use it for a child of an existing file too. */
export function canTreatThreadPathAsMissingSync(
  file: string,
  probe: (path: string) => DirectoryStat = statSync
): boolean {
  let parent = dirname(file)
  for (;;) {
    try {
      return probe(parent).isDirectory()
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') return false
    }
    const next = dirname(parent)
    if (next === parent) return false
    parent = next
  }
}

export async function canTreatThreadPathAsMissing(
  file: string,
  probe: (path: string) => Promise<DirectoryStat> = stat
): Promise<boolean> {
  let parent = dirname(file)
  for (;;) {
    try {
      return (await probe(parent)).isDirectory()
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') return false
    }
    const next = dirname(parent)
    if (next === parent) return false
    parent = next
  }
}

/** File sharing can briefly deny an atomic replacement while another process reads. */
export async function renameThreadFile(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform
    rename?: (from: string, to: string) => Promise<void>
    wait?: (milliseconds: number) => Promise<void>
  } = {}
): Promise<void> {
  const move = options.rename ?? rename
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(from, to)
      return
    } catch (error) {
      if (
        (options.platform ?? process.platform) !== 'win32' ||
        attempt >= 9 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(codeOf(error) ?? '')
      )
        throw error
      await wait(20)
    }
  }
}

/** O_NOFOLLOW is absent on Windows; compare the opened file and its current name. */
export async function openThreadFile(
  file: string,
  flags: number,
  platform: NodeJS.Platform = process.platform
): Promise<FileHandle> {
  if (platform !== 'win32') return open(file, flags)
  const before = await lstat(file, { bigint: true })
  const invalid = () =>
    Object.assign(new Error('Thread file is not a stable regular file'), { code: 'EINVAL' })
  if (!before.isFile() || before.isSymbolicLink()) throw invalid()
  const handle = await open(file, flags)
  try {
    const opened = await handle.stat({ bigint: true })
    const named = await lstat(file, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw invalid()
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}
