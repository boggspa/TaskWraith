import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<Writable | void>
}
const {
  NOTICE_FILES,
  generateThirdPartyNotices,
  packageRootForManifest,
  validatePackagedNotices
}: {
  NOTICE_FILES: Record<'app' | 'chromium' | 'inventory' | 'thirdParty', string>
  generateThirdPartyNotices: (options: {
    resourcesDir: string
    repoRoot: string
    electronVersion?: string
  }) => {
    summary: {
      packageIdentityCount: number
      packageInstanceCount: number
      reviewedOverrideCount: number
      upstreamLimitationCount: number
    }
  }
  packageRootForManifest: (manifestPath: string) => string | null
  validatePackagedNotices: (resourcesDir: string) => unknown
} = require('../build/third-party-notices.cjs')

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function write(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function writeJson(filePath: string, value: unknown): void {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function addPackage(
  appDir: string,
  name: string,
  version: string,
  options: { license?: string; legalFile?: string; legalText?: string } = {}
): void {
  const packageDir = path.join(appDir, 'node_modules', ...name.split('/'))
  writeJson(path.join(packageDir, 'package.json'), {
    name,
    version,
    license: options.license || 'MIT',
    author: `${name} author`,
    repository: `https://example.test/${name}`
  })
  if (options.legalFile) {
    write(path.join(packageDir, options.legalFile), options.legalText || `${name} license\n`)
  }
}

async function fixture(
  packages: (appDir: string) => void,
  overridePackages: Record<string, unknown> = {}
): Promise<{ repoRoot: string; resourcesDir: string }> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-notices-'))
  tempRoots.push(repoRoot)
  const appDir = path.join(repoRoot, 'app')
  const resourcesDir = path.join(repoRoot, 'resources')
  fs.mkdirSync(resourcesDir, { recursive: true })
  writeJson(path.join(appDir, 'package.json'), {
    name: 'taskwraith',
    version: '9.9.9',
    license: 'Apache-2.0'
  })
  write(path.join(appDir, 'LICENSE'), 'TaskWraith Apache license\n')
  packages(appDir)
  // @electron/asar 3.4 resolves createPackage with its Writable after calling
  // end(), not after the stream's finish event. Under the full parallel suite,
  // reading immediately can therefore observe zero-filled payload slots.
  const archiveStream = await asar.createPackage(appDir, path.join(resourcesDir, 'app.asar'))
  if (archiveStream) await finished(archiveStream)

  const electronRoot = path.join(repoRoot, 'node_modules', 'electron')
  writeJson(path.join(electronRoot, 'package.json'), {
    name: 'electron',
    version: '39.8.9',
    license: 'MIT'
  })
  write(path.join(electronRoot, 'dist', 'LICENSE'), 'Electron MIT license\n')
  write(
    path.join(electronRoot, 'dist', 'LICENSES.chromium.html'),
    '<html>Chromium notices</html>\n'
  )

  const nodeLicense = 'Node.js and bundled dependency licenses\n'
  const runtimeRoot = path.join(resourcesDir, 'tui-runtime')
  write(path.join(runtimeRoot, 'darwin-arm64', 'LICENSE'), nodeLicense)
  writeJson(path.join(runtimeRoot, 'RUNTIME.json'), {
    nodeVersion: '22.23.2',
    targets: [
      {
        dirName: 'darwin-arm64',
        license: 'LICENSE',
        licenseSha256: hash(nodeLicense),
        licenseSource: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz#LICENSE'
      }
    ]
  })
  writeJson(path.join(repoRoot, 'build', 'third-party-license-overrides.json'), {
    schemaVersion: 1,
    packages: overridePackages
  })
  return { repoRoot, resourcesDir }
}

describe('packaged third-party notices', () => {
  it('binds generation to afterPack and verification to the finished-package smoke', () => {
    const afterPack = fs.readFileSync(
      path.join(process.cwd(), 'build', 'validate-native-modules.cjs'),
      'utf8'
    )
    const packagedSmoke = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
      'utf8'
    )
    expect(afterPack).toContain('generateThirdPartyNotices({')
    expect(packagedSmoke).toContain('validatePackagedNotices(resourcesDir)')
  })

  it('recognizes only package-root manifests under nested node_modules paths', () => {
    expect(packageRootForManifest('/node_modules/plain/package.json')).toBe('node_modules/plain')
    expect(packageRootForManifest('node_modules/@scope/pkg/package.json')).toBe(
      'node_modules/@scope/pkg'
    )
    expect(packageRootForManifest('node_modules/a/node_modules/b/package.json')).toBe(
      'node_modules/a/node_modules/b'
    )
    expect(packageRootForManifest('node_modules/a/examples/package.json')).toBeNull()
  })

  it('maps every architecture package declared by the canvas parent release', () => {
    const canvasPackage = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'node_modules/@napi-rs/canvas/package.json'), 'utf8')
    ) as { optionalDependencies?: Record<string, string> }
    const overrides = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'build/third-party-license-overrides.json'), 'utf8')
    ) as { packages: Record<string, { kind?: string; sourcePackage?: string }> }
    const expectedIdentities = Object.entries(canvasPackage.optionalDependencies ?? {})
      .map(([name, version]) => `${name}@${version}`)
      .sort()
    const mappedIdentities = Object.keys(overrides.packages)
      .filter((identity) => identity.startsWith('@napi-rs/canvas-'))
      .sort()

    expect(mappedIdentities).toEqual(expectedIdentities)
    for (const identity of expectedIdentities) {
      expect(overrides.packages[identity]).toMatchObject({
        kind: 'package-file',
        sourcePackage: '@napi-rs/canvas@1.0.2'
      })
    }
  })

  it('generates deterministic coverage from packaged legal files and reviewed mappings', async () => {
    const bundledText = 'Bundled exact upstream MIT notice\n'
    const bundledRelative = 'build/third-party-license-texts/bundled.LICENSE.txt'
    const overridePackages = {
      'child@1.0.0': {
        kind: 'package-file',
        sourcePackage: 'parent@1.0.0',
        file: 'LICENSE',
        expectedSha256: hash('Parent MIT license\n'),
        source: 'https://example.test/parent/LICENSE',
        reason: 'Child and parent are one versioned upstream distribution.'
      },
      'bundled@1.0.0': {
        kind: 'bundled-file',
        file: bundledRelative,
        expectedSha256: hash(bundledText),
        source: 'https://example.test/bundled/LICENSE',
        reason: 'The release tarball omitted its repository license.',
        upstreamLimitation: 'The upstream package omitted standalone legal text.'
      }
    }
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', {
        legalFile: 'LICENSE-MIT.txt',
        legalText: 'Good MIT license\n'
      })
      addPackage(appDir, 'parent', '1.0.0', {
        legalFile: 'LICENSE',
        legalText: 'Parent MIT license\n'
      })
      addPackage(appDir, 'child', '1.0.0')
      addPackage(appDir, 'bundled', '1.0.0')
      addPackage(appDir, 'named', '1.0.0', {
        license: 'SEE LICENSE IN README.md',
        legalFile: 'README.md',
        legalText: 'Named license in README\n'
      })
    }, overridePackages)
    write(path.join(repoRoot, bundledRelative), bundledText)

    const inventory = generateThirdPartyNotices({
      resourcesDir,
      repoRoot,
      electronVersion: '39.8.9'
    })

    expect(inventory.summary).toEqual({
      packageIdentityCount: 5,
      packageInstanceCount: 5,
      reviewedOverrideCount: 2,
      upstreamLimitationCount: 1
    })
    const notice = fs.readFileSync(path.join(resourcesDir, NOTICE_FILES.thirdParty), 'utf8')
    expect(notice).toContain('Good MIT license')
    expect(notice).toContain('Parent MIT license')
    expect(notice).toContain('Bundled exact upstream MIT notice')
    expect(notice).toContain('Named license in README')
    expect(notice).toContain('Electron 39.8.9')
    expect(notice).toContain('Node.js standalone TUI runtime 22.23.2')
    expect(validatePackagedNotices(resourcesDir)).toBeTruthy()
  })

  it('fails packaging when a dependency has neither legal text nor a reviewed mapping', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'uncovered', '1.2.3')
    })

    expect(() => generateThirdPartyNotices({ resourcesDir, repoRoot })).toThrow(/uncovered@1\.2\.3/)
  })

  it('fails when a version-pinned mapping no longer matches its retained text', async () => {
    const { repoRoot, resourcesDir } = await fixture(
      (appDir) => {
        addPackage(appDir, 'child', '1.0.0')
        addPackage(appDir, 'parent', '1.0.0', {
          legalFile: 'LICENSE',
          legalText: 'Changed license bytes\n'
        })
      },
      {
        'child@1.0.0': {
          kind: 'package-file',
          sourcePackage: 'parent@1.0.0',
          file: 'LICENSE',
          expectedSha256: 'a'.repeat(64),
          source: 'https://example.test/parent/LICENSE',
          reason: 'Explicit parent mapping.'
        }
      }
    )

    expect(() => generateThirdPartyNotices({ resourcesDir, repoRoot })).toThrow(/SHA-256 mismatch/)
  })

  it('detects notice tampering after generation', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    fs.appendFileSync(path.join(resourcesDir, NOTICE_FILES.thirdParty), 'tampered\n')

    expect(() => validatePackagedNotices(resourcesDir)).toThrow(/SHA-256 mismatch/)
  })
})
