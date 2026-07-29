import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  findTaskWraithApp,
  resolveMacArtifacts
}: {
  findTaskWraithApp: (root: string) => string | null
  resolveMacArtifacts: (distDir: string, version: string) => { dmg: string; zip: string }
} = require('./smoke-mac-artifacts.cjs')

describe('macOS packaged artifact smoke', () => {
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
