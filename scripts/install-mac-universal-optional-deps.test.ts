import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS,
  DARWIN_NODE_PTY_PREBUILDS,
  ensureDarwinNodePtyPrebuilds,
  parseNpmPackOutput,
  pruneMacNodePtyHostBuild,
  resolveDarwinClaudeSdkPackages
}: {
  DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS: string[]
  DARWIN_NODE_PTY_PREBUILDS: string[]
  ensureDarwinNodePtyPrebuilds: (repoRoot: string) => string[]
  parseNpmPackOutput: (output: string) => string
  pruneMacNodePtyHostBuild: (repoRoot: string) => boolean
  resolveDarwinClaudeSdkPackages: (lock: unknown) => Array<{
    name: string
    version: string
    spec: string
  }>
} = require('./install-mac-universal-optional-deps.cjs')

describe('install-mac-universal-optional-deps script', () => {
  it('resolves both Darwin Claude SDK helper packages from package-lock entries', () => {
    const packages = resolveDarwinClaudeSdkPackages({
      packages: {
        'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': {
          version: '0.2.141'
        },
        'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64': {
          version: '0.2.141'
        }
      }
    })

    expect(packages.map((item) => item.spec)).toEqual([
      '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.141',
      '@anthropic-ai/claude-agent-sdk-darwin-x64@0.2.141'
    ])
  })

  it('fails clearly if a required helper package is missing from the lockfile', () => {
    expect(() =>
      resolveDarwinClaudeSdkPackages({
        packages: {
          'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': {
            version: '0.2.141'
          }
        }
      })
    ).toThrow('Missing @anthropic-ai/claude-agent-sdk-darwin-x64 version in package-lock.json.')
  })

  it('extracts the packed tarball name from npm pack JSON output', () => {
    expect(
      parseNpmPackOutput(
        JSON.stringify([
          {
            filename: 'anthropic-ai-claude-agent-sdk-darwin-x64-0.2.141.tgz'
          }
        ])
      )
    ).toBe('anthropic-ai-claude-agent-sdk-darwin-x64-0.2.141.tgz')
  })

  it('fails clearly if node-pty Darwin prebuilds are missing', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-node-pty-missing-'))
    try {
      expect(() => ensureDarwinNodePtyPrebuilds(repoRoot)).toThrow(
        'Missing node-pty Darwin prebuilds'
      )
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('prunes stale node-pty host build output after Darwin prebuild validation', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-node-pty-prune-'))
    try {
      const nodePtyDir = path.join(repoRoot, 'node_modules', 'node-pty')
      for (const relativePath of DARWIN_NODE_PTY_PREBUILDS) {
        const prebuildPath = path.join(nodePtyDir, relativePath)
        fs.mkdirSync(path.dirname(prebuildPath), { recursive: true })
        fs.writeFileSync(prebuildPath, 'binary')
      }
      const hostBuild = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
      fs.mkdirSync(path.dirname(hostBuild), { recursive: true })
      fs.writeFileSync(hostBuild, 'host-only')

      expect(ensureDarwinNodePtyPrebuilds(repoRoot)).toEqual(DARWIN_NODE_PTY_PREBUILDS)
      expect(pruneMacNodePtyHostBuild(repoRoot)).toBe(true)
      expect(fs.existsSync(path.join(nodePtyDir, 'build'))).toBe(false)
      expect(pruneMacNodePtyHostBuild(repoRoot)).toBe(false)
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('repairs executable permissions on node-pty Darwin spawn helpers', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-node-pty-mode-'))
    try {
      const nodePtyDir = path.join(repoRoot, 'node_modules', 'node-pty')
      for (const relativePath of DARWIN_NODE_PTY_PREBUILDS) {
        const prebuildPath = path.join(nodePtyDir, relativePath)
        fs.mkdirSync(path.dirname(prebuildPath), { recursive: true })
        fs.writeFileSync(prebuildPath, 'binary')
        fs.chmodSync(prebuildPath, 0o644)
      }

      expect(ensureDarwinNodePtyPrebuilds(repoRoot)).toEqual(DARWIN_NODE_PTY_PREBUILDS)
      for (const relativePath of DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS) {
        const mode = fs.statSync(path.join(nodePtyDir, relativePath)).mode & 0o777
        expect(mode & 0o111).toBe(0o111)
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
