import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { graftTerminalKeychainAccess } from './TerminalKeychainGraft'

function makeTempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), 'taskwraith-terminal-keychain-test-'))
}

describe('graftTerminalKeychainAccess', () => {
  it('skips grafting off macOS', () => {
    const root = makeTempRoot()
    try {
      const realKeychainsDir = join(root, 'real-Keychains')
      mkdirSync(realKeychainsDir, { recursive: true })
      const home = join(root, 'terminal-home')
      mkdirSync(home, { recursive: true })

      expect(graftTerminalKeychainAccess(home, { platform: 'linux', realKeychainsDir })).toBeNull()
      expect(() => lstatSync(join(home, 'Library', 'Keychains'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the terminal home untouched when there is no real keychain directory', () => {
    const root = makeTempRoot()
    try {
      const home = join(root, 'terminal-home')
      mkdirSync(home, { recursive: true })

      expect(
        graftTerminalKeychainAccess(home, {
          platform: 'darwin',
          realKeychainsDir: join(root, 'missing-Keychains')
        })
      ).toBeNull()
      expect(() => lstatSync(join(home, 'Library', 'Keychains'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('symlinks the real keychain directory into the isolated home and keeps it on re-graft', () => {
    const root = makeTempRoot()
    try {
      const realKeychainsDir = join(root, 'real-Keychains')
      mkdirSync(realKeychainsDir, { recursive: true })
      const home = join(root, 'terminal-home')
      mkdirSync(home, { recursive: true })

      const linkPath = graftTerminalKeychainAccess(home, {
        platform: 'darwin',
        realKeychainsDir
      })

      expect(linkPath).toBe(join(home, 'Library', 'Keychains'))
      expect(lstatSync(linkPath as string).isSymbolicLink()).toBe(true)
      expect(readlinkSync(linkPath as string)).toBe(realKeychainsDir)

      expect(graftTerminalKeychainAccess(home, { platform: 'darwin', realKeychainsDir })).toBe(
        linkPath
      )
      expect(readlinkSync(linkPath as string)).toBe(realKeychainsDir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-points a graft that no longer resolves to the expected keychain directory', () => {
    const root = makeTempRoot()
    try {
      const realKeychainsDir = join(root, 'real-Keychains')
      const decoyDir = join(root, 'decoy-Keychains')
      mkdirSync(realKeychainsDir, { recursive: true })
      mkdirSync(decoyDir, { recursive: true })
      const home = join(root, 'terminal-home')
      mkdirSync(join(home, 'Library'), { recursive: true })
      writeFileSync(join(decoyDir, 'decoy.txt'), 'decoy')

      const before = graftTerminalKeychainAccess(home, {
        platform: 'darwin',
        realKeychainsDir: decoyDir
      })
      expect(readlinkSync(before as string)).toBe(decoyDir)

      const after = graftTerminalKeychainAccess(home, {
        platform: 'darwin',
        realKeychainsDir
      })
      expect(after).toBe(join(home, 'Library', 'Keychains'))
      expect(readlinkSync(after as string)).toBe(realKeychainsDir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
