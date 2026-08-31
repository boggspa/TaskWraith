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
  listPackage: (archivePath: string, options?: { isPack?: boolean }) => string[]
}
const {
  NOTICE_FILES,
  generateThirdPartyNotices,
  packageRootForManifest,
  readEmulatorNotice,
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
  readEmulatorNotice: (resourcesDir: string, repoRoot?: string) => unknown
  packageRootForManifest: (manifestPath: string) => string | null
  validatePackagedNotices: (resourcesDir: string, options?: { repoRoot?: string }) => unknown
} = require('../build/third-party-notices.cjs')

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function write(filePath: string, value: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function writeJson(filePath: string, value: unknown): void {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeEmulatorBundle(resourcesDir: string, repoRoot: string): void {
  const root = path.join(resourcesDir, 'emulator', 'homebrew-demo')
  const sourceReceiptPath = path.join(process.cwd(), 'scripts', 'emulator', 'build-receipt.json')
  const sourceReceiptBytes = fs.readFileSync(sourceReceiptPath)
  const sourceReceipt = JSON.parse(sourceReceiptBytes.toString('utf8')) as {
    pins: {
      emscripten: {
        emsdkCommit: string
        emscriptenSourceCommit: string
        version: string
      }
      shippedCore: {
        commit: string
        object: { sha256: string }
        ref: string
        repository: string
        version: string
      }
    }
    source: {
      fixture: {
        files: Record<string, string>
        rom: { byteLength: number; sha256: string }
      }
      host: { path: string; sha256: string }
    }
    validationOnly: {
      sameboy: { commit: string; purpose: string; repository: string; version: string }
    }
  }
  write(path.join(repoRoot, 'scripts', 'emulator', 'build-receipt.json'), sourceReceiptBytes)
  const assets = [
    {
      path: 'index.html',
      bytes: Buffer.from('<!doctype html><title>Fixture</title>'),
      mimeType: 'text/html'
    },
    {
      path: 'style.css',
      bytes: Buffer.from('canvas { image-rendering: pixelated; }\n'),
      mimeType: 'text/css'
    },
    {
      path: 'bootstrap.mjs',
      bytes: Buffer.from('export const fixture = true\n'),
      mimeType: 'application/javascript'
    },
    {
      path: 'twgb.mjs',
      bytes: Buffer.from('export default async () => ({})\n'),
      mimeType: 'application/javascript'
    },
    {
      path: 'twgb.wasm',
      bytes: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      mimeType: 'application/wasm'
    }
  ]
  for (const asset of assets) write(path.join(root, asset.path), asset.bytes)
  const manifest = {
    schemaVersion: 1,
    gameId: 'homebrew-demo',
    entryPath: 'index.html',
    assets: assets.map((asset) => ({
      path: asset.path,
      sha256: hash(asset.bytes),
      byteLength: asset.bytes.byteLength,
      mimeType: asset.mimeType
    }))
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  write(path.join(root, 'manifest.json'), manifestBytes)

  const licenses = {
    'LICENSES/SameBoy-libretro-MIT.txt': 'SameBoy MIT license\n',
    'LICENSES/Libretro-common-MIT.txt': 'libretro-common MIT license\n',
    'LICENSES/Emscripten-MIT-AND-NCSA.txt': 'Emscripten MIT and NCSA license\n',
    'LICENSES/TaskWraith-fixture-MIT.txt': 'TaskWraith fixture MIT license\n'
  }
  for (const [relativePath, text] of Object.entries(licenses))
    write(path.join(root, relativePath), text)
  const license = (relativePath: keyof typeof licenses, spdx: string) => ({
    spdx,
    path: relativePath,
    sha256: hash(licenses[relativePath]),
    byteLength: Buffer.byteLength(licenses[relativePath])
  })
  const provenance = {
    schemaVersion: 1,
    sourceReceipt: {
      commit: 'e57e122dc282f87420e52f506092967b6717fc2a',
      path: 'scripts/emulator/build-receipt.json',
      sha256: hash(sourceReceiptBytes)
    },
    bundle: {
      gameId: 'homebrew-demo',
      runtimeManifest: {
        path: 'manifest.json',
        sha256: hash(manifestBytes),
        byteLength: manifestBytes.byteLength
      },
      artifacts: manifest.assets.filter((asset) => asset.path.startsWith('twgb.'))
    },
    components: [
      {
        id: 'taskwraith-twemu-host',
        license: 'Apache-2.0',
        source: {
          ...sourceReceipt.source.host,
          path: 'scripts/emulator/twemu_host.c'
        },
        embeddedArtifacts: ['twgb.wasm']
      },
      {
        id: 'sameboy-libretro',
        license: license('LICENSES/SameBoy-libretro-MIT.txt', 'MIT'),
        source: {
          repository: sourceReceipt.pins.shippedCore.repository,
          ref: sourceReceipt.pins.shippedCore.ref,
          commit: sourceReceipt.pins.shippedCore.commit,
          version: sourceReceipt.pins.shippedCore.version,
          coreObjectSha256: sourceReceipt.pins.shippedCore.object.sha256
        },
        embeddedArtifacts: ['twgb.wasm']
      },
      {
        id: 'libretro-common',
        license: license('LICENSES/Libretro-common-MIT.txt', 'MIT'),
        source: {
          vendoredWithSameBoyCommit: sourceReceipt.pins.shippedCore.commit,
          path: 'libretro/libretro-common/include/libretro.h',
          copyright: 'The RetroArch team (2010-2020)'
        },
        embeddedArtifacts: ['twgb.wasm']
      },
      {
        id: 'emscripten-runtime',
        license: license('LICENSES/Emscripten-MIT-AND-NCSA.txt', 'MIT OR NCSA'),
        source: {
          repository: 'https://github.com/emscripten-core/emscripten.git',
          version: sourceReceipt.pins.emscripten.version,
          emsdkCommit: sourceReceipt.pins.emscripten.emsdkCommit,
          emscriptenSourceCommit: sourceReceipt.pins.emscripten.emscriptenSourceCommit
        },
        embeddedArtifacts: ['twgb.mjs', 'twgb.wasm']
      },
      {
        id: 'taskwraith-fixture',
        license: license('LICENSES/TaskWraith-fixture-MIT.txt', 'MIT'),
        source: {
          mainAsmSha256: sourceReceipt.source.fixture.files['src/main.asm'],
          hardwareIncludeSha256: sourceReceipt.source.fixture.files['src/hardware.inc'],
          romSha256: sourceReceipt.source.fixture.rom.sha256,
          romByteLength: sourceReceipt.source.fixture.rom.byteLength
        },
        embeddedArtifacts: ['twgb.wasm']
      }
    ],
    validationOnly: {
      sameboy: sourceReceipt.validationOnly.sameboy
    }
  }
  writeJson(path.join(root, 'component-provenance.json'), provenance)
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
  writeEmulatorBundle(resourcesDir, repoRoot)
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
    expect(inventory).toMatchObject({
      emulator: {
        gameId: 'homebrew-demo',
        root: 'emulator/homebrew-demo',
        components: [
          { id: 'taskwraith-twemu-host', license: null },
          { id: 'sameboy-libretro', license: { spdx: 'MIT' } },
          { id: 'libretro-common', license: { spdx: 'MIT' } },
          { id: 'emscripten-runtime', license: { spdx: 'MIT OR NCSA' } },
          { id: 'taskwraith-fixture', license: { spdx: 'MIT' } }
        ]
      },
      sourceScope: 'exact-packaged-app-asar-and-resources'
    })
    expect(readEmulatorNotice(resourcesDir, repoRoot)).toBeTruthy()
    const notice = fs.readFileSync(path.join(resourcesDir, NOTICE_FILES.thirdParty), 'utf8')
    expect(notice).toContain('Good MIT license')
    expect(notice).toContain('Parent MIT license')
    expect(notice).toContain('Bundled exact upstream MIT notice')
    expect(notice).toContain('Named license in README')
    expect(notice).toContain('Electron 39.8.9')
    expect(notice).toContain('Node.js standalone TUI runtime 22.23.2')
    expect(notice).toContain('SameBoy MIT license')
    expect(notice).toContain('libretro-common MIT license')
    expect(notice).toContain('Emscripten MIT and NCSA license')
    expect(notice).toContain('TaskWraith fixture MIT license')
    expect(validatePackagedNotices(resourcesDir, { repoRoot })).toBeTruthy()
  })

  it('does not mutate the cached ASAR header while reading notices', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    const archivePath = path.join(resourcesDir, 'app.asar')
    const before = asar.listPackage(archivePath, { isPack: false })

    generateThirdPartyNotices({ resourcesDir, repoRoot })

    expect(asar.listPackage(archivePath, { isPack: false })).toEqual(before)
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

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(/SHA-256 mismatch/)
  })

  it('rejects a tampered packaged emulator artifact after generation', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    fs.appendFileSync(
      path.join(resourcesDir, 'emulator', 'homebrew-demo', 'twgb.wasm'),
      Buffer.from([0])
    )

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /Emulator asset twgb\.wasm/
    )
  })

  it('rejects a missing packaged emulator license after generation', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    fs.rmSync(
      path.join(resourcesDir, 'emulator', 'homebrew-demo', 'LICENSES', 'Libretro-common-MIT.txt')
    )

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /missing or unexpected files/
    )
  })

  it('rejects an unexpected packaged emulator payload file after generation', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    write(path.join(resourcesDir, 'emulator', 'homebrew-demo', 'unreviewed.bin'), 'unexpected\n')

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /missing or unexpected files/
    )
  })

  it('rejects an emulator provenance source pin that differs from the committed receipt', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    const provenancePath = path.join(
      resourcesDir,
      'emulator',
      'homebrew-demo',
      'component-provenance.json'
    )
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
      components: Array<{ id: string; source: { commit?: string } }>
    }
    const sameBoy = provenance.components.find((component) => component.id === 'sameboy-libretro')
    if (!sameBoy) throw new Error('fixture has no SameBoy provenance')
    sameBoy.source.commit = '0'.repeat(40)
    writeJson(provenancePath, provenance)

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /SameBoy provenance commit/
    )
  })

  it('rejects an emulator component with an unexpected embedded-artifact set', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    const provenancePath = path.join(
      resourcesDir,
      'emulator',
      'homebrew-demo',
      'component-provenance.json'
    )
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
      components: Array<{ id: string; embeddedArtifacts: string[] }>
    }
    const host = provenance.components.find((component) => component.id === 'taskwraith-twemu-host')
    if (!host) throw new Error('fixture has no host provenance')
    host.embeddedArtifacts = ['twgb.mjs']
    writeJson(provenancePath, provenance)

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /taskwraith-twemu-host has an invalid artifact list/
    )
  })

  it('rejects an emulator component with an unexpected SPDX license', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    const provenancePath = path.join(
      resourcesDir,
      'emulator',
      'homebrew-demo',
      'component-provenance.json'
    )
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
      components: Array<{ id: string; license: { spdx: string } }>
    }
    const sameBoy = provenance.components.find((component) => component.id === 'sameboy-libretro')
    if (!sameBoy) throw new Error('fixture has no SameBoy provenance')
    sameBoy.license.spdx = 'BSD-3-Clause'
    writeJson(provenancePath, provenance)

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /sameboy-libretro has an unexpected SPDX license/
    )
  })

  it('rejects an emulator source-receipt reference that differs from the committed receipt', async () => {
    const { repoRoot, resourcesDir } = await fixture((appDir) => {
      addPackage(appDir, 'good', '1.0.0', { legalFile: 'LICENSE' })
    })
    generateThirdPartyNotices({ resourcesDir, repoRoot })
    const provenancePath = path.join(
      resourcesDir,
      'emulator',
      'homebrew-demo',
      'component-provenance.json'
    )
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as {
      sourceReceipt: { sha256: string }
    }
    provenance.sourceReceipt.sha256 = '0'.repeat(64)
    writeJson(provenancePath, provenance)

    expect(() => validatePackagedNotices(resourcesDir, { repoRoot })).toThrow(
      /not bound to the committed source receipt/
    )
  })
})
