import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_STDERR_LOG_MAX_BYTES,
  closeHostStderrLogFd,
  hostStderrLogPath,
  hostStderrLogPreviousPath,
  openHostStderrLogFd
} from './hostStderrLog'

const roots: string[] = []

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'tw-host-stderr-log-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('host stderr log', () => {
  it('captures what the Host writes to the returned fd, creating the directory', () => {
    const root = profile()

    const fd = openHostStderrLogFd(root)
    expect(fd).not.toBeNull()
    // Exactly what a spawned Host does with the inherited fd 2.
    writeFileSync(fd as number, 'provider spawn failed: ENOENT claude\n')
    closeHostStderrLogFd(fd)

    expect(readFileSync(hostStderrLogPath(root), 'utf8')).toBe(
      'provider spawn failed: ENOENT claude\n'
    )
  })

  it('appends across launches so an earlier failure survives the next start', () => {
    const root = profile()

    const first = openHostStderrLogFd(root)
    writeFileSync(first as number, 'first launch\n')
    closeHostStderrLogFd(first)

    const second = openHostStderrLogFd(root)
    writeFileSync(second as number, 'second launch\n')
    closeHostStderrLogFd(second)

    expect(readFileSync(hostStderrLogPath(root), 'utf8')).toBe('first launch\nsecond launch\n')
  })

  it('rotates once past the cap and preserves the previous generation', () => {
    const root = profile()
    mkdirSync(join(root, 'host-runtime'), { recursive: true })
    // One byte over the cap is the smallest thing that must rotate.
    writeFileSync(hostStderrLogPath(root), 'x'.repeat(HOST_STDERR_LOG_MAX_BYTES + 1))

    const fd = openHostStderrLogFd(root)
    writeFileSync(fd as number, 'after rotation\n')
    closeHostStderrLogFd(fd)

    expect(readFileSync(hostStderrLogPath(root), 'utf8')).toBe('after rotation\n')
    expect(statSync(hostStderrLogPreviousPath(root)).size).toBe(HOST_STDERR_LOG_MAX_BYTES + 1)
  })

  it('does not rotate while the log is still under the cap', () => {
    const root = profile()
    mkdirSync(join(root, 'host-runtime'), { recursive: true })
    writeFileSync(hostStderrLogPath(root), 'y'.repeat(HOST_STDERR_LOG_MAX_BYTES - 1))

    closeHostStderrLogFd(openHostStderrLogFd(root))

    expect(statSync(hostStderrLogPath(root)).size).toBe(HOST_STDERR_LOG_MAX_BYTES - 1)
    expect(() => statSync(hostStderrLogPreviousPath(root))).toThrow()
  })

  it('fails open with null rather than throwing when the log cannot be opened', () => {
    const root = profile()
    // A FILE where the host-runtime directory must go: mkdirSync throws ENOTDIR.
    // Logging must never be able to stop the Host from launching.
    writeFileSync(join(root, 'host-runtime'), 'not a directory')

    expect(openHostStderrLogFd(root)).toBeNull()
    expect(openHostStderrLogFd('')).toBeNull()
  })

  it('tolerates closing a null or already-closed fd', () => {
    const root = profile()
    const fd = openHostStderrLogFd(root) as number

    closeSync(fd)

    expect(() => closeHostStderrLogFd(fd)).not.toThrow()
    expect(() => closeHostStderrLogFd(null)).not.toThrow()
  })
})
