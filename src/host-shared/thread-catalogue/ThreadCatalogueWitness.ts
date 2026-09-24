import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { isSafeChatId } from '../../shared/ChatPath'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'
export interface ThreadCatalogueReaderOptions {
  profilePath: string
  runtimeInstanceId: string
  defaultProvider?: string
  segmented: boolean
}

export interface ThreadCatalogueSourceWitness {
  witness: string
  legacyExists: boolean
  sourceBytes: number
}

function fileIdentity(file: string): { identity: string; bytes: number; exists: boolean } {
  try {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false })
    if (!stat) return { identity: 'absent', bytes: 0, exists: false }
    if (!stat.isFile()) throw new Error('History source is not a regular file')
    return {
      identity: `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.mode}`,
      bytes: Number(stat.size),
      exists: true
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { identity: 'absent', bytes: 0, exists: false }
    throw error
  }
}

/** File metadata only. This runs in the storage process, including segmented-prefix discovery. */
function catalogueSourceFiles(options: ThreadCatalogueReaderOptions, chatId: string): Set<string> {
  if (!isSafeChatId(chatId)) throw new Error('Invalid history chat id')
  const root = options.profilePath
  const legacy = path.join(root, 'chats', `${chatId}.json`)
  const files = new Set([
    legacy,
    path.join(root, 'chat-journal-v2', `${chatId}.checkpoint.json`),
    path.join(root, 'chat-journal-v2', `${chatId}.mutations.jsonl`),
    path.join(root, 'chat-journal-v2', `${chatId}.tombstone`),
    path.join(root, 'chat-composer-selections', `${chatId}.json`)
  ])
  if (options.segmented) {
    const directory = path.join(root, 'chat-store-v2')
    let names: string[] = []
    try {
      names = fs.readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const queue = [chatId]
    const visited = new Set<string>()
    while (queue.length) {
      const id = queue.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      const manifestPath = path.join(directory, `${id}.manifest.json`)
      files.add(manifestPath)
      files.add(path.join(directory, `${id}.snapshot.json`))
      files.add(path.join(directory, `${id}.tombstone`))
      for (const name of names) {
        if (name.startsWith(`${id}.segment-`) && /^\d+\.jsonl$/.test(name.slice(id.length + 9))) {
          files.add(path.join(directory, name))
        }
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const parent = manifest?.prefix?.chatId
        if (typeof parent === 'string' && isSafeChatId(parent)) queue.push(parent)
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        )
          throw error
        // An invalid manifest's own identity still invalidates the witness.
      }
    }
  }
  return files
}

export function captureThreadCatalogueWitness(
  options: ThreadCatalogueReaderOptions,
  chatId: string
): ThreadCatalogueSourceWitness {
  const root = options.profilePath
  const legacy = path.join(root, 'chats', `${chatId}.json`)
  const entries = [...catalogueSourceFiles(options, chatId)]
    .sort()
    .map((file) => ({ file: path.relative(root, file), ...fileIdentity(file) }))
  const legacyEntry = entries.find((entry) => entry.file === path.relative(root, legacy))!
  return {
    witness: createHash('sha256')
      .update(JSON.stringify({ version: 1, segmented: options.segmented, entries }))
      .digest('hex'),
    legacyExists: legacyEntry.exists,
    sourceBytes: entries.reduce((total, entry) => total + entry.bytes, 0)
  }
}

/** Repair only indeterminate source durability, under the existing profile authority. */
export async function flushThreadCatalogueSources(
  options: ThreadCatalogueReaderOptions,
  chatId: string,
  assertAuthority: () => void
): Promise<string> {
  assertAuthority()
  const before = captureThreadCatalogueWitness(options, chatId)
  if (!before.legacyExists) throw new Error('History source disappeared before durability repair')
  const files = catalogueSourceFiles(options, chatId)
  const directories = new Set([options.profilePath])
  for (const file of files) {
    assertAuthority()
    let handle: fs.promises.FileHandle
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    try {
      await handle.sync()
      directories.add(path.dirname(file))
    } finally {
      await handle.close()
    }
  }
  for (const directory of directories) {
    assertAuthority()
    let handle: fs.promises.FileHandle | undefined
    try {
      handle = await fs.promises.open(directory, 'r')
      await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (
        !['EINVAL', 'ENOTSUP'].includes(code) &&
        !(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code))
      )
        throw error
    } finally {
      await handle?.close()
    }
  }
  assertAuthority()
  if (captureThreadCatalogueWitness(options, chatId).witness !== before.witness)
    throw new ThreadCatalogueRequestError('source_changed')
  return before.witness
}
