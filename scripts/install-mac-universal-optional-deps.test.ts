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
  missingNapiCanvasPackages,
  parseNpmPackOutput,
  pruneMacNodePtyHostBuild,
  resolveDarwinClaudeSdkPackages,
  resolveDarwinNapiCanvasPackages
}: {
  DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS: string[]
  DARWIN_NODE_PTY_PREBUILDS: string[]
  ensureDarwinNodePtyPrebuilds: (repoRoot: string) => string[]
  missingNapiCanvasPackages: (
    repoRoot: string,
    packages: Array<{ name: string; version: string; spec: string }>
  ) => Array<{ name: string; version: string; spec: string }>
  parseNpmPackOutput: (output: string) => string
  pruneMacNodePtyHostBuild: (repoRoot: string) => boolean
  resolveDarwinClaudeSdkPackages: (lock: unknown) => Array<{
    name: string
    version: string
    spec: string
  }>
  resolveDarwinNapiCanvasPackages: (lock: unknown) => Array<{
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

  it('resolves both Darwin @napi-rs/canvas packages from package-lock entries', () => {
    const packages = resolveDarwinNapiCanvasPackages({
      packages: {
        'node_modules/@napi-rs/canvas-darwin-arm64': {
          version: '1.0.2'
        },
        'node_modules/@napi-rs/canvas-darwin-x64': {
          version: '1.0.2'
        }
      }
    })

    expect(packages.map((item) => item.spec)).toEqual([
      '@napi-rs/canvas-darwin-arm64@1.0.2',
      '@napi-rs/canvas-darwin-x64@1.0.2'
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

  it('fails clearly if a required canvas package is missing from the lockfile', () => {
    expect(() =>
      resolveDarwinNapiCanvasPackages({
        packages: {
          'node_modules/@napi-rs/canvas-darwin-arm64': {
            version: '1.0.2'
          }
        }
      })
    ).toThrow('Missing @napi-rs/canvas-darwin-x64 version in package-lock.json.')
  })

  it('detects missing @napi-rs/canvas Darwin packages when the .node binding is absent', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-canvas-missing-'))
    try {
      const armPackage = path.join(repoRoot, 'node_modules', '@napi-rs', 'canvas-darwin-arm64')
      fs.mkdirSync(armPackage, { recursive: true })
      fs.writeFileSync(path.join(armPackage, 'package.json'), '{}')
      // No skia.*.node — should still count as missing.

      const packages = [
        {
          name: '@napi-rs/canvas-darwin-arm64',
          version: '1.0.2',
          spec: '@napi-rs/canvas-darwin-arm64@1.0.2'
        },
        {
          name: '@napi-rs/canvas-darwin-x64',
          version: '1.0.2',
          spec: '@napi-rs/canvas-darwin-x64@1.0.2'
        }
      ]
      expect(missingNapiCanvasPackages(repoRoot, packages).map((item) => item.name)).toEqual([
        '@napi-rs/canvas-darwin-arm64',
        '@napi-rs/canvas-darwin-x64'
      ])
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
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
        const helperPath = path.join(nodePtyDir, relativePath)
        expect(fs.existsSync(helperPath)).toBe(true)
        if (process.platform !== 'win32') {
          const mode = fs.statSync(helperPath).mode & 0o777
          expect(mode & 0o111).toBe(0o111)
        }
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
