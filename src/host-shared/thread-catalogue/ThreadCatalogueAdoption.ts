import { preparedThreadDirectory } from './ThreadCataloguePreparedPath'
import * as fs from 'node:fs'
import { join, basename } from 'node:path'
import {
  captureThreadCatalogueWitness,
  type ThreadCatalogueReaderOptions
} from './ThreadCatalogueWitness'
import {
  type PreparedThreadMutation,
  type PreparedThreadFile
} from '../../shared/threadCatalogueTypes'
import type { ThreadCatalogueEpoch } from './ThreadCatalogue'

function matches(stat: fs.BigIntStats, expected: PreparedThreadFile): boolean {
  return (
    stat.isFile() &&
    String(stat.dev) === expected.device &&
    String(stat.ino) === expected.inode &&
    String(stat.size) === String(expected.byteLength) &&
    String(stat.mtimeNs) === expected.modified &&
    String(stat.ctimeNs) === expected.changed
  )
}

/** The caller owns source admission. No await may separate the final guard from authoritative rename. */
export function adoptPreparedThreadRecord(
  options: ThreadCatalogueReaderOptions,
  prepared: PreparedThreadMutation,
  guard: { assert(): void; epoch(): ThreadCatalogueEpoch }
): void {
  guard.assert()
  if (JSON.stringify(guard.epoch()) !== JSON.stringify(prepared.epoch))
    throw new Error('History was erased before recovery')
  if (captureThreadCatalogueWitness(options, prepared.chatId).witness !== prepared.sourceWitness)
    throw new Error('History changed before recovery')
  const descriptor = prepared.record
  if (
    basename(descriptor.name) !== descriptor.name ||
    descriptor.name !== `${prepared.preparedId}.record.json`
  )
    throw new Error('Invalid prepared history identity')
  const file = join(preparedThreadDirectory(options.profilePath, prepared.chatId), descriptor.name)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (
      !matches(fs.fstatSync(fd, { bigint: true }), descriptor) ||
      !matches(fs.lstatSync(file, { bigint: true }), descriptor)
    )
      throw new Error('Prepared history file changed')
    guard.assert()
    if (
      JSON.stringify(guard.epoch()) !== JSON.stringify(prepared.epoch) ||
      captureThreadCatalogueWitness(options, prepared.chatId).witness !== prepared.sourceWitness
    )
      throw new Error('History changed before recovery')
    fs.renameSync(file, join(options.profilePath, 'chats', `${prepared.chatId}.json`))
    let directory: number | undefined
    try {
      directory = fs.openSync(join(options.profilePath, 'chats'), 'r')
      fs.fsyncSync(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (
        !['EINVAL', 'ENOTSUP'].includes(code) &&
        !(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code))
      )
        throw error
    } finally {
      if (directory !== undefined) fs.closeSync(directory)
    }
  } finally {
    fs.closeSync(fd)
  }
}
