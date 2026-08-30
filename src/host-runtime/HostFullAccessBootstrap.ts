import { closeSync, createReadStream, fstatSync, type Stats } from 'node:fs'
import type { Readable } from 'node:stream'

export const HOST_FULL_ACCESS_BOOTSTRAP_FD = 3
/** Non-secret launch marker; the 32-byte secret travels only over fd3. */
export const HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV = 'TASKWRAITH_FULL_ACCESS_BOOTSTRAP_FD'
export const HOST_FULL_ACCESS_BOOTSTRAP_PREFIX = 'TASKWRAITH_FULL_ACCESS_V1:'
const PREFIX_BYTES = Buffer.from(HOST_FULL_ACCESS_BOOTSTRAP_PREFIX, 'ascii')
const SECRET_BYTES = 32
const FRAME_BYTES = PREFIX_BYTES.byteLength + SECRET_BYTES + 1
const DEFAULT_READ_TIMEOUT_MS = 2_000

export interface HostFullAccessBootstrapIo {
  fstatSync(fd: number): Pick<Stats, 'isFIFO' | 'isFile'>
  createReadStream(fd: number): Readable
  closeSync(fd: number): void
}

const nodeIo: HostFullAccessBootstrapIo = {
  fstatSync,
  createReadStream: (fd) => createReadStream('', { fd, autoClose: false }),
  closeSync
}

export function hostFullAccessBootstrapFrame(secret: Buffer): Buffer {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== SECRET_BYTES) {
    throw new TypeError('Full Access bootstrap secret must be 32 bytes.')
  }
  const frame = Buffer.alloc(FRAME_BYTES)
  PREFIX_BYTES.copy(frame, 0)
  secret.copy(frame, PREFIX_BYTES.byteLength)
  frame[FRAME_BYTES - 1] = 0x0a
  return frame
}

/**
 * Consume one fixed inherited anonymous-pipe frame. No secret is read from
 * argv, environment, disk, stdin, or the authenticated Host token. Callers
 * must separately prove that fd3 was intentionally supplied; probing an
 * arbitrary Node/libuv-owned descriptor is unsafe. Any ambiguity fails closed.
 */
export async function readHostFullAccessBootstrapSecret(
  fd = HOST_FULL_ACCESS_BOOTSTRAP_FD,
  options: {
    readonly io?: HostFullAccessBootstrapIo
    readonly timeoutMs?: number
  } = {}
): Promise<Buffer | null> {
  const io = options.io ?? nodeIo
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    try {
      io.closeSync(fd)
    } catch {
      // Invalid timeout is capability-off; fd cleanup is best effort.
    }
    return null
  }
  const frame = Buffer.alloc(FRAME_BYTES + 1)
  let stream: Readable | null = null
  try {
    const stat = io.fstatSync(fd)
    if (stat.isFile() || !stat.isFIFO()) return null
    stream = io.createReadStream(fd)
    return await new Promise<Buffer | null>((resolveRead) => {
      let settled = false
      let bytes = 0
      const finish = (secret: Buffer | null): void => {
        if (settled) {
          secret?.fill(0)
          return
        }
        settled = true
        clearTimeout(timer)
        stream?.off('data', onData)
        stream?.off('end', onEnd)
        stream?.off('error', onError)
        // Retain a no-op listener while destroy settles so a late read error is
        // never unhandled after timeout/overflow resolution.
        stream?.on('error', () => {})
        try {
          stream?.destroy()
        } catch {
          // Capability is already off; teardown remains best effort.
        }
        resolveRead(secret)
      }
      const parse = (): Buffer | null => {
        if (bytes !== FRAME_BYTES) return null
        if (!frame.subarray(0, PREFIX_BYTES.byteLength).equals(PREFIX_BYTES)) return null
        if (frame[FRAME_BYTES - 1] !== 0x0a) return null
        return Buffer.from(
          frame.subarray(PREFIX_BYTES.byteLength, PREFIX_BYTES.byteLength + SECRET_BYTES)
        )
      }
      const onData = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        try {
          if (bytes + data.byteLength > frame.byteLength) {
            finish(null)
            return
          }
          data.copy(frame, bytes)
          bytes += data.byteLength
        } finally {
          if (Buffer.isBuffer(chunk)) chunk.fill(0)
          else data.fill(0)
        }
      }
      const onEnd = (): void => finish(parse())
      const onError = (): void => finish(null)
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref?.()
      stream!.on('data', onData)
      stream!.once('end', onEnd)
      stream!.once('error', onError)
    })
  } catch {
    return null
  } finally {
    frame.fill(0)
    try {
      io.closeSync(fd)
    } catch {
      // Closed/absent bootstrap fd is the ordinary capability-off state.
    }
  }
}
