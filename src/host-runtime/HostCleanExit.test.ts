/**
 * Independent Threads M4 slice 14b (design §24.3, SF-1; tests owed, item 1):
 * the Host's clean-exit marker.
 *
 * - A missing marker reads unclean.
 * - Record then consume reads clean and removes the file; a second consume
 *   reads unclean, because the marker is consumed durably before anything in
 *   the new incarnation can write.
 * - An unreadable marker (a directory at the path) reads unclean.
 * - Recording over an existing marker replaces it, leaving no temp sibling.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  consumeHostCleanExit,
  HOST_CLEAN_EXIT_FILENAME,
  recordHostCleanExit
} from './HostCleanExit'

const TIMEOUT = 5_000

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function runtimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-clean-exit-'))
  roots.push(dir)
  return dir
}

function markerPath(dir: string): string {
  return join(dir, HOST_CLEAN_EXIT_FILENAME)
}

describe('HostCleanExit (M4 slice 14b, SF-1)', () => {
  it(
    'names the marker host-clean-exit.json in the runtime directory',
    () => {
      expect(HOST_CLEAN_EXIT_FILENAME).toBe('host-clean-exit.json')
      const dir = runtimeDir()
      recordHostCleanExit(dir, () => 1_760_000_000_000)
      expect(existsSync(markerPath(dir))).toBe(true)
    },
    TIMEOUT
  )

  it(
    'a missing marker reads unclean and touches nothing',
    () => {
      const dir = runtimeDir()
      expect(consumeHostCleanExit(dir)).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'a missing runtime directory reads unclean rather than throwing',
    () => {
      const dir = join(runtimeDir(), 'never-created')
      expect(consumeHostCleanExit(dir)).toBe(false)
      expect(existsSync(dir)).toBe(false)
    },
    TIMEOUT
  )

  it(
    'record then consume reads clean and removes the file; a second consume reads unclean',
    () => {
      const dir = runtimeDir()
      const cleanAt = 1_760_000_123_456
      recordHostCleanExit(dir, () => cleanAt)

      const written = JSON.parse(readFileSync(markerPath(dir), 'utf8')) as Record<string, unknown>
      expect(written.cleanAt).toBe(cleanAt)
      expect(lstatSync(markerPath(dir)).isFile()).toBe(true)
      // Only the marker: the temp file was renamed into place, not left beside it.
      expect(readdirSync(dir)).toEqual([HOST_CLEAN_EXIT_FILENAME])

      expect(consumeHostCleanExit(dir)).toBe(true)
      expect(existsSync(markerPath(dir))).toBe(false)
      expect(readdirSync(dir)).toEqual([])

      // Consumed: a crash later in this incarnation must read unclean.
      expect(consumeHostCleanExit(dir)).toBe(false)
      expect(consumeHostCleanExit(dir)).toBe(false)
    },
    TIMEOUT
  )

  it(
    'an unreadable marker (a directory at the path) reads unclean',
    () => {
      const dir = runtimeDir()
      mkdirSync(markerPath(dir))
      expect(consumeHostCleanExit(dir)).toBe(false)
      // Still unclean on a retry: nothing turned the directory into a clean exit.
      expect(consumeHostCleanExit(dir)).toBe(false)
    },
    TIMEOUT
  )

  it(
    'recording over an existing marker replaces it, leaving one clean exit to consume',
    () => {
      const dir = runtimeDir()
      recordHostCleanExit(dir, () => 1_000)
      recordHostCleanExit(dir, () => 2_000)

      expect(readdirSync(dir)).toEqual([HOST_CLEAN_EXIT_FILENAME])
      const written = JSON.parse(readFileSync(markerPath(dir), 'utf8')) as Record<string, unknown>
      expect(written.cleanAt).toBe(2_000)

      expect(consumeHostCleanExit(dir)).toBe(true)
      expect(consumeHostCleanExit(dir)).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'record, consume, record again: each clean exit is consumed exactly once',
    () => {
      const dir = runtimeDir()
      recordHostCleanExit(dir, () => 1_000)
      expect(consumeHostCleanExit(dir)).toBe(true)
      expect(consumeHostCleanExit(dir)).toBe(false)
      recordHostCleanExit(dir, () => 2_000)
      expect(consumeHostCleanExit(dir)).toBe(true)
      expect(consumeHostCleanExit(dir)).toBe(false)
    },
    TIMEOUT
  )
})
