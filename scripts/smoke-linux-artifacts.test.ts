import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  findPackagedRoot,
  resolveLinuxArtifacts,
  validateDebMetadata
}: {
  findPackagedRoot: (root: string) => string | null
  resolveLinuxArtifacts: (
    distDir: string,
    version: string,
    architecture?: string
  ) => { appImage: string; deb: string }
  validateDebMetadata: (text: string, version: string, architecture: string) => string[]
} = require('./smoke-linux-artifacts.cjs')

describe('Linux packaged artifact smoke', () => {
  it('finds an extracted Electron package root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-artifacts-'))
    const packageRoot = path.join(root, 'usr', 'lib', 'taskwraith')
    fs.mkdirSync(path.join(packageRoot, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'resources', 'app.asar'), '')
    try {
      expect(findPackagedRoot(root)).toBe(packageRoot)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires the exact versioned AppImage and one versioned deb', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-artifacts-'))
    fs.writeFileSync(path.join(root, 'TaskWraith-1.9.2.AppImage'), '')
    fs.writeFileSync(path.join(root, 'taskwraith_1.9.2_amd64.deb'), '')
    try {
      expect(resolveLinuxArtifacts(root, '1.9.2', 'x64')).toEqual({
        appImage: path.join(root, 'TaskWraith-1.9.2.AppImage'),
        deb: path.join(root, 'taskwraith_1.9.2_amd64.deb')
      })
      expect(() => resolveLinuxArtifacts(root, '1.9.1', 'x64')).toThrow('Missing Linux AppImage')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects substring version collisions and validates deb control metadata exactly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-artifacts-'))
    fs.writeFileSync(path.join(root, 'TaskWraith-1.9.2.AppImage'), '')
    fs.writeFileSync(path.join(root, 'taskwraith_11.9.20_amd64.deb'), '')
    try {
      expect(() => resolveLinuxArtifacts(root, '1.9.2', 'x64')).toThrow('Missing exact Linux deb')
      expect(
        validateDebMetadata(
          'Package: taskwraith\nVersion: 1.9.2\nArchitecture: amd64\n',
          '1.9.2',
          'amd64'
        )
      ).toEqual([])
      expect(
        validateDebMetadata(
          'Package: taskwraith\nVersion: 1.9.2~beta.1\nArchitecture: amd64\n',
          '1.9.2-beta.1',
          'amd64'
        )
      ).toEqual([])
      expect(
        validateDebMetadata(
          'Package: other\nVersion: 11.9.20\nArchitecture: arm64\n',
          '1.9.2',
          'amd64'
        )
      ).toHaveLength(3)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
