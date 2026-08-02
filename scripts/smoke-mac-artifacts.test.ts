import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  detachMountedImage,
  findTaskWraithApp,
  resolveMacArtifacts
}: {
  detachMountedImage: (
    mountPoint: string,
    options: {
      maxAttempts: number
      run: ReturnType<typeof vi.fn>
      wait: ReturnType<typeof vi.fn>
    }
  ) => { status: number }
  findTaskWraithApp: (root: string) => string | null
  resolveMacArtifacts: (distDir: string, version: string) => { dmg: string; zip: string }
} = require('./smoke-mac-artifacts.cjs')

describe('macOS packaged artifact smoke', () => {
  it('retries a briefly busy mounted image before reporting cleanup failure', () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValue({ status: 0 })
    const wait = vi.fn()

    expect(detachMountedImage('/tmp/taskwraith-dmg', { maxAttempts: 4, run, wait })).toEqual({
      status: 0
    })
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith('hdiutil', ['detach', '/tmp/taskwraith-dmg'], {
      encoding: 'utf8',
      timeout: 30_000
    })
    expect(wait.mock.calls).toEqual([[250], [500]])
  })

  it('requires exact versioned universal ZIP and DMG containers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-artifacts-'))
    const dmg = path.join(root, 'TaskWraith-1.9.2-universal-mac.dmg')
    const zip = path.join(root, 'TaskWraith-1.9.2-universal-mac.zip')
    fs.writeFileSync(dmg, '')
    fs.writeFileSync(zip, '')
    try {
      expect(resolveMacArtifacts(root, '1.9.2')).toEqual({ dmg, zip })
      expect(() => resolveMacArtifacts(root, '1.9.1')).toThrow(
        'Missing exact macOS release artifact'
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds TaskWraith.app inside an extracted or mounted container', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-artifacts-'))
    const app = path.join(root, 'payload', 'TaskWraith.app')
    fs.mkdirSync(app, { recursive: true })
    try {
      expect(findTaskWraithApp(root)).toBe(app)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
