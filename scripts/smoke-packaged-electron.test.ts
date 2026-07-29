import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('packaged Electron to TUI smoke handoff', () => {
  it('passes the exact package root instead of rediscovering an architecture sibling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-package-siblings-'))
    const x64 = path.join(root, 'win-unpacked')
    const arm64 = path.join(root, 'win-arm64-unpacked')
    fs.mkdirSync(path.join(x64, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(arm64, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(x64, 'resources', 'app.asar'), '')
    fs.writeFileSync(path.join(arm64, 'resources', 'app.asar'), '')

    try {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
        'utf8'
      )
      expect(source).toContain('spawnSync(process.execPath, [smokeScript, packageRoot]')
      expect(source).not.toContain('const searchRoot = path.dirname(packageRoot)')
      expect(fs.existsSync(path.join(x64, 'resources', 'app.asar'))).toBe(true)
      expect(fs.existsSync(path.join(arm64, 'resources', 'app.asar'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
