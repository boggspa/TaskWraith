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

import type { HostExternalPreparationWriterGate } from './HostExternalPreparation'

export const DESKTOP_WRITER_FENCE_FILENAME = 'taskwraith-legacy-writer-gate-v1.json'
export const DESKTOP_WRITER_FENCE_PURPOSE = 'taskwraith:legacy-store-writer-gate:v1'
const PRIVATE_FILE_MODE = 0o600

export interface DesktopWriterFenceOwnership {
  readonly hostId: string
  readonly generation: number
  readonly cutoverId: string
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
  return join(canonicalProfilePath(profilePath), DESKTOP_WRITER_FENCE_FILENAME)
}

export function writeDesktopWriterFence(
  profilePath: string,
  input: {
    readonly state: 'draining' | 'host-owned' | 'closed'
    readonly ownership?: DesktopWriterFenceOwnership
  }
): void {
  const snapshot = {
    schemaVersion: 1 as const,
    purpose: DESKTOP_WRITER_FENCE_PURPOSE,
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

export function readDesktopWriterFence(profilePath: string): {
  readonly schemaVersion: 1
  readonly purpose: typeof DESKTOP_WRITER_FENCE_PURPOSE
  readonly state: 'draining' | 'host-owned' | 'closed'
  readonly ownership?: DesktopWriterFenceOwnership
} | null {
  const path = fencePath(profilePath)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as {
    readonly schemaVersion: 1
    readonly purpose: typeof DESKTOP_WRITER_FENCE_PURPOSE
    readonly state: 'draining' | 'host-owned' | 'closed'
    readonly ownership?: DesktopWriterFenceOwnership
  }
}

export function clearDesktopWriterFence(profilePath: string): boolean {
  const path = fencePath(profilePath)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/** Mirror in-memory gate transitions to a durable fence file the Host can consult. */
export function persistLegacyStoreWriterGate(
  profilePath: string,
  gate: HostExternalPreparationWriterGate
): HostExternalPreparationWriterGate {
  const sync = (): void => {
    const snapshot = gate.snapshot()
    if (snapshot.state === 'open') {
      clearDesktopWriterFence(profilePath)
      return
    }
    if (
      snapshot.state === 'draining' ||
      snapshot.state === 'host-owned' ||
      snapshot.state === 'closed'
    ) {
      writeDesktopWriterFence(profilePath, {
        state: snapshot.state,
        ...(snapshot.ownership ? { ownership: snapshot.ownership } : {})
      })
    }
  }
  return {
    beginDrain(): boolean {
      const ok = gate.beginDrain()
      if (ok) sync()
      return ok
    },
    awaitDrained(): Promise<void> {
      return gate.awaitDrained()
    },
    markHostOwned(input: { hostId: string; generation: number; cutoverId: string }): boolean {
      const ok = gate.markHostOwned(input)
      if (ok) sync()
      return ok
    },
    rollbackDrain(): boolean {
      const ok = gate.rollbackDrain()
      if (ok) sync()
      return ok
    },
    snapshot() {
      return gate.snapshot()
    }
  }
}
