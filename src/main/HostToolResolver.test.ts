import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The resolver's whole job is probing real dirs for real executables, so the
// search-dir list is the seam we mock — the fs behaviour underneath stays real.
const searchDirs = vi.hoisted(() => ({ value: [] as string[] }))

vi.mock('./providers/CliSearchDirs', () => ({
  getCliSearchDirs: () => searchDirs.value,
  cliBinaryNameCandidates: (name: string) => [name]
}))

import {
  __resetHostToolResolverCache,
  findExecutableOnHost,
  getHostToolSnapshot,
  hostToolMissingError,
  hostToolPath,
  resolveHostTool
} from './HostToolResolver'

let tmpDir: string

function writeBinary(name: string, mode: number): string {
  const target = path.join(tmpDir, name)
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode })
  fs.chmodSync(target, mode)
  return target
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tool-resolver-'))
  searchDirs.value = [tmpDir]
  __resetHostToolResolverCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  __resetHostToolResolverCache()
})

describe('findExecutableOnHost', () => {
  it('resolves an executable on the search path', () => {
    const expected = writeBinary('ffmpeg', 0o755)
    expect(findExecutableOnHost('ffmpeg')).toBe(expected)
  })

  it('rejects a present-but-not-executable file', () => {
    // The regression this guards: resolveCliProviderBinary uses a stat-only
    // `fileExists`, so a non-executable file named `ffmpeg` would resolve there
    // and then fail at spawn time. This resolver checks X_OK.
    writeBinary('ffmpeg', 0o644)
    expect(findExecutableOnHost('ffmpeg')).toBeNull()
  })

  it('returns null when the binary is absent', () => {
    expect(findExecutableOnHost('ffmpeg')).toBeNull()
  })

  it('skips empty search dirs without throwing', () => {
    searchDirs.value = ['', tmpDir]
    const expected = writeBinary('pdftotext', 0o755)
    expect(findExecutableOnHost('pdftotext')).toBe(expected)
  })
})

describe('resolveHostTool caching', () => {
  it('caches a miss so the hot path does not re-stat', () => {
    expect(resolveHostTool('pdftotext').available).toBe(false)
    // Install it *after* the first probe — the cached miss must persist, because
    // getNativeCapabilitySnapshot() runs on every renderer IPC request.
    writeBinary('pdftotext', 0o755)
    expect(resolveHostTool('pdftotext').available).toBe(false)
  })

  it('re-probes when forced, so a mid-session install is picked up', () => {
    expect(resolveHostTool('pdftotext').available).toBe(false)
    const expected = writeBinary('pdftotext', 0o755)
    expect(resolveHostTool('pdftotext', true)).toMatchObject({
      available: true,
      path: expected
    })
  })

  it('exposes the resolved path through hostToolPath', () => {
    const expected = writeBinary('ffprobe', 0o755)
    expect(hostToolPath('ffprobe')).toBe(expected)
  })
})

describe('hostToolMissingError', () => {
  it('names the real install package per tool', () => {
    expect(hostToolMissingError('ffmpeg')).toContain('brew install ffmpeg')
    // pdftoppm and pdftotext both ship in poppler — the hint must say so rather
    // than naming the binary as if it were its own formula.
    expect(hostToolMissingError('pdftotext')).toContain('brew install poppler')
    expect(hostToolMissingError('pdftoppm')).toContain('brew install poppler')
  })

  it('keeps the ffmpeg wording the existing tool-error assertions rely on', () => {
    expect(hostToolMissingError('ffmpeg')).toContain('install ffmpeg')
  })
})

describe('getHostToolSnapshot', () => {
  it('reports every registered tool with a reason when absent', () => {
    const expected = writeBinary('ffmpeg', 0o755)
    const snapshot = getHostToolSnapshot()

    expect(snapshot.ffmpeg).toMatchObject({ available: true, path: expected })
    expect(snapshot.ffprobe.available).toBe(false)
    expect(snapshot.ffprobe.reason).toContain('brew install ffmpeg')
    expect(snapshot.pdftoppm.available).toBe(false)
    expect(snapshot.pdftotext.available).toBe(false)
  })
})
