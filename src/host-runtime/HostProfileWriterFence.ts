import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import {
  HostProfileAuthorityLease,
  type HostProfileAuthorityOwnerLiveness,
  type HostProfileAuthorityPeek
} from './HostProfileAuthorityLease'

/** On-disk Desktop/Host writer fence. Filename is stable; do not rename. */
export const HOST_PROFILE_WRITER_FENCE_FILENAME = 'taskwraith-legacy-writer-gate-v1.json'
export const HOST_PROFILE_WRITER_FENCE_PURPOSE = 'taskwraith:legacy-store-writer-gate:v1'
export const IN_PROCESS_DESKTOP_HOST_ID = 'electron-in-process-host'
const PRIVATE_FILE_MODE = 0o600

export type HostProfileWriterFenceState = 'draining' | 'host-owned' | 'closed'

export interface HostProfileWriterFenceOwnership {
  readonly hostId: string
  readonly generation: number
  readonly cutoverId: string
  readonly pid?: number
}

export interface HostProfileWriterFenceSnapshot {
  readonly schemaVersion: 1
  readonly purpose: typeof HOST_PROFILE_WRITER_FENCE_PURPOSE
  readonly state: HostProfileWriterFenceState
  readonly ownership?: HostProfileWriterFenceOwnership
}

export type HostProfileWriterPeer =
  | { readonly status: 'clear' }
  | { readonly status: 'stale' }
  | {
      readonly status: 'live-host'
      readonly ownership?: HostProfileWriterFenceOwnership
      readonly pid: number
    }
  | {
      readonly status: 'live-in-process'
      readonly ownership: HostProfileWriterFenceOwnership
      readonly pid: number
    }
  | {
      readonly status: 'self-in-process'
      readonly ownership: HostProfileWriterFenceOwnership
      readonly pid: number
    }
  | { readonly status: 'unknown'; readonly reason: string }

export class ProfileWriterLivePeerError extends Error {
  readonly reason: string

  constructor(message: string, reason = 'live-peer') {
    super(message)
    this.name = 'ProfileWriterLivePeerError'
    this.reason = reason
  }
}

export interface InspectProfileWriterPeersOptions {
  readonly currentPid?: number
  readonly inspectPid?: (pid: number) => HostProfileAuthorityOwnerLiveness
  readonly peekLease?: (input: { profilePath: string }) => HostProfileAuthorityPeek
}

function canonicalProfilePath(profilePath: string): string {
  if (typeof profilePath !== 'string' || !isAbsolute(profilePath))
    throw new Error('Writer fence requires an absolute profile path.')
  const resolved = resolve(profilePath)
  if (resolved === parse(resolved).root)
    throw new Error('Writer fence refuses a filesystem-root profile.')
  return resolved
}

function fencePath(profilePath: string): string {
  return join(canonicalProfilePath(profilePath), HOST_PROFILE_WRITER_FENCE_FILENAME)
}

function canonicalMetadata(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- writer metadata rejects terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function canonicalPid(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  )
}

function parseOwnership(value: unknown): HostProfileWriterFenceOwnership | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (
    !canonicalMetadata(item.hostId) ||
    !canonicalMetadata(item.cutoverId) ||
    !Number.isSafeInteger(item.generation) ||
    (item.generation as number) < 0
  ) {
    return undefined
  }
  if (item.pid !== undefined && !canonicalPid(item.pid)) return undefined
  return {
    hostId: item.hostId,
    generation: item.generation as number,
    cutoverId: item.cutoverId,
    ...(item.pid !== undefined ? { pid: item.pid as number } : {})
  }
}

function parseSnapshot(raw: string): HostProfileWriterFenceSnapshot | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1 || item.purpose !== HOST_PROFILE_WRITER_FENCE_PURPOSE) return null
  if (item.state !== 'draining' && item.state !== 'host-owned' && item.state !== 'closed')
    return null
  const ownership = parseOwnership(item.ownership)
  if (item.ownership !== undefined && ownership === undefined) return null
  return {
    schemaVersion: 1,
    purpose: HOST_PROFILE_WRITER_FENCE_PURPOSE,
    state: item.state,
    ...(ownership ? { ownership } : {})
  }
}

export function writeHostProfileWriterFence(
  profilePath: string,
  input: {
    readonly state: HostProfileWriterFenceState
    readonly ownership?: HostProfileWriterFenceOwnership
  }
): void {
  const snapshot: HostProfileWriterFenceSnapshot = {
    schemaVersion: 1,
    purpose: HOST_PROFILE_WRITER_FENCE_PURPOSE,
    state: input.state,
    ...(input.ownership ? { ownership: input.ownership } : {})
  }
  const path = fencePath(profilePath)
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const payload = `${JSON.stringify(snapshot)}\n`
  let fd: number | null = null
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE
    )
    writeFileSync(fd, payload, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tempPath, path)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Best-effort close of a failed exclusive temp.
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // Temp may already be gone.
    }
    throw error
  }
}

export function readHostProfileWriterFence(
  profilePath: string
): HostProfileWriterFenceSnapshot | null {
  const record = readHostProfileWriterFenceRecord(profilePath)
  return record.kind === 'ok' ? record.snapshot : null
}

export function readHostProfileWriterFenceRecord(
  profilePath: string
):
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly snapshot: HostProfileWriterFenceSnapshot } {
  const path = fencePath(profilePath)
  if (!existsSync(path)) return { kind: 'absent' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'invalid' }
  }
  const snapshot = parseSnapshot(raw)
  return snapshot ? { kind: 'ok', snapshot } : { kind: 'invalid' }
}

export function clearHostProfileWriterFence(profilePath: string): boolean {
  const path = fencePath(profilePath)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function defaultInspectPid(pid: number): HostProfileAuthorityOwnerLiveness {
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return 'stale'
    return 'unknown'
  }
}

function classifyInProcessPid(
  ownership: HostProfileWriterFenceOwnership,
  pid: number,
  liveness: HostProfileAuthorityOwnerLiveness,
  currentPid: number
): HostProfileWriterPeer {
  if (liveness === 'unknown') {
    return { status: 'unknown', reason: 'in-process-owner-liveness-unproven' }
  }
  if (liveness !== 'live') return { status: 'stale' }
  if (pid === currentPid) return { status: 'self-in-process', ownership, pid }
  return { status: 'live-in-process', ownership, pid }
}

export function inspectProfileWriterPeers(
  profilePath: string,
  options: InspectProfileWriterPeersOptions = {}
): HostProfileWriterPeer {
  const currentPid = options.currentPid ?? process.pid
  const inspectPid = options.inspectPid ?? defaultInspectPid
  const peekLease = options.peekLease ?? ((input) => HostProfileAuthorityLease.peek(input))

  let lease: HostProfileAuthorityPeek
  try {
    lease = peekLease({ profilePath })
  } catch {
    return { status: 'unknown', reason: 'host-authority-peek-failed' }
  }
  if (lease.kind === 'unreadable') {
    return { status: 'unknown', reason: 'host-authority-unreadable' }
  }
  if (lease.kind === 'unknown') {
    return { status: 'unknown', reason: 'host-authority-liveness-unproven' }
  }

  const fence = readHostProfileWriterFenceRecord(profilePath)
  if (fence.kind === 'invalid') {
    return { status: 'unknown', reason: 'malformed-writer-fence' }
  }

  if (lease.kind === 'live') {
    return {
      status: 'live-host',
      ...(fence.kind === 'ok' ? { ownership: fence.snapshot.ownership } : {}),
      pid: lease.owner.pid
    }
  }

  if (fence.kind !== 'ok') return { status: 'clear' }
  const snapshot = fence.snapshot
  const ownership = snapshot.ownership

  if (ownership?.hostId === IN_PROCESS_DESKTOP_HOST_ID) {
    if (!canonicalPid(ownership.pid)) {
      return { status: 'unknown', reason: 'in-process-owner-missing-pid' }
    }
    return classifyInProcessPid(ownership, ownership.pid, inspectPid(ownership.pid), currentPid)
  }

  if (
    snapshot.state === 'draining' ||
    snapshot.state === 'host-owned' ||
    snapshot.state === 'closed'
  ) {
    return { status: 'stale' }
  }
  return { status: 'clear' }
}

export function assertHostMayOpenProfileWriters(
  profilePath: string,
  options: InspectProfileWriterPeersOptions = {}
): void {
  const peer = inspectProfileWriterPeers(profilePath, options)
  if (peer.status === 'live-in-process') {
    throw new ProfileWriterLivePeerError(
      `Desktop in-process Host pid ${peer.pid} already owns this profile.`,
      'live-in-process'
    )
  }
  if (peer.status === 'self-in-process') {
    throw new ProfileWriterLivePeerError(
      `This process already owns the profile as the in-process Desktop Host.`,
      'self-in-process'
    )
  }
  if (peer.status === 'unknown') {
    throw new ProfileWriterLivePeerError(`Refusing Host writers; ${peer.reason}.`, peer.reason)
  }
}
