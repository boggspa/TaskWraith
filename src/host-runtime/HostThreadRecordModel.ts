/**
 * A thread's public-window model read from its committed chat file
 * (Independent Threads M4, slice 13c1).
 *
 * The feeder asks for this after a writer other than the transaction or the
 * run port replaced a record: setup, the seat toggle, the legacy persist,
 * catalogue adoption. Those writers are rare, so the full model is built from
 * the file, in the transfer worker, and only the bounded effect model comes
 * back to the Host loop.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join, parse } from 'node:path'

import {
  decodeHostProfileThread,
  HOST_PROFILE_CHATS_DIRECTORY,
  isHostProfileId,
  MAX_CHAT_BYTES
} from './HostProfileDomainStore'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordEffectModel
} from './HostThreadRecordEffectModel'

export interface HostThreadRecordModelInput {
  readonly profilePath: string
  readonly threadId: string
}

export type HostThreadRecordFileModel =
  | { readonly kind: 'absent' }
  /** Unreadable, oversized, not JSON, refused by the decoder, or another thread's record. */
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'modelled'
      readonly revision: number
      readonly effects: HostThreadRecordEffectModel
    }

export function modelHostThreadRecordFile(
  input: HostThreadRecordModelInput
): HostThreadRecordFileModel {
  if (!isHostProfileId(input.threadId)) return { kind: 'invalid' }
  const directory = join(input.profilePath, HOST_PROFILE_CHATS_DIRECTORY)
  const path = join(directory, `${input.threadId}.json`)
  // The id is one path segment: the join can only name a direct child.
  if (parse(path).dir !== directory) return { kind: 'invalid' }

  let body: string
  try {
    const before = lstatSync(path)
    if (!before.isFile()) return { kind: 'invalid' }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = fstatSync(fd)
      if (
        !opened.isFile() ||
        opened.size > MAX_CHAT_BYTES ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev
      ) {
        return { kind: 'invalid' }
      }
      body = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'invalid' }
  }

  try {
    const decoded = decodeHostProfileThread(JSON.parse(body) as unknown)
    if (decoded.appChatId !== input.threadId) return { kind: 'invalid' }
    const revision = decoded.persistenceRevision
    return {
      kind: 'modelled',
      revision: typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : 0,
      effects: modelHostThreadRecordEffects(decoded)
    }
  } catch {
    return { kind: 'invalid' }
  }
}
