import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Options } from 'prettier'
import { describe, expect, it } from 'vitest'
import {
  createEmulatorAssetRegistry,
  emulatorAssetRoot,
  emulatorAssetUrl,
  loadEmulatorAssetBundle,
  resolveEmulatorAsset,
  sha256Hex
} from './EmulatorAssetManifest'
import { EMULATOR_DOCUMENT_CSP } from './EmulatorAssetProtocol'
import {
  loadEmulatorPackageManifest,
  validateTwgbHomebrewDemoPackage
} from './EmulatorPackageManifest'

const require = createRequire(import.meta.url)
const prettier = require('prettier') as {
  check(source: string, options: Options): Promise<boolean>
  getFileInfo(filePath: string, options: { ignorePath: string }): Promise<{ ignored: boolean }>
  resolveConfig(filePath: string): Promise<Options | null>
}

const REPOSITORY_ROOT = process.cwd()
const BUNDLE_ROOT = path.join(REPOSITORY_ROOT, 'resources', 'emulator', 'homebrew-demo')
const EXPECTED_ASSETS = [
  {
    path: 'index.html',
    sha256: '2207f5060f565ca3018afeb4985e74b6c33b159cf1b51be3c7c6722f4f9034d7',
    byteLength: 907,
    mimeType: 'text/html'
  },
  {
    path: 'style.css',
    sha256: '7a34ea952e6ff8eed9f10648583b0d560ac07b9f397a5fd3e3e3ebbbcf511f52',
    byteLength: 1221,
    mimeType: 'text/css'
  },
  {
    path: 'bootstrap.mjs',
    sha256: 'f43d4a37da7bf8717bf5ae37017c2f304a2acaf12726878a42ab542b5a1bb5cb',
    byteLength: 18576,
    mimeType: 'application/javascript'
  },
  {
    path: 'twgb.mjs',
    sha256: '01550656c449f123de6f6519c0820433c3d48c1a9496e20d0a4d2dc6ffe26d6c',
    byteLength: 64092,
    mimeType: 'application/javascript'
  },
  {
    path: 'twgb.wasm',
    sha256: 'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf',
    byteLength: 214835,
    mimeType: 'application/wasm'
  }
] as const
const EXPECTED_COMPONENT_LICENSES = [
  {
    id: 'sameboy-libretro',
    spdx: 'MIT',
    path: 'LICENSES/SameBoy-libretro-MIT.txt',
    sha256: '00b4b03270ea21b70b4b51fbc93c6eb43876e46ceb742e74918e459ea2481f21',
    byteLength: 1073
  },
  {
    id: 'libretro-common',
    spdx: 'MIT',
    path: 'LICENSES/Libretro-common-MIT.txt',
    sha256: '376ce330786c201893e52981576d4907780c6de11b26f972ba3cb023c58a7f6c',
    byteLength: 1067
  },
  {
    id: 'emscripten-runtime',
    spdx: 'MIT OR NCSA',
    path: 'LICENSES/Emscripten-MIT-AND-NCSA.txt',
    sha256: '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    byteLength: 5093
  },
  {
    id: 'taskwraith-fixture',
    spdx: 'MIT',
    path: 'LICENSES/TaskWraith-fixture-MIT.txt',
    sha256: 'e7eb982b2ff9dc303bfcb68ee2046667d6c745001f9785ce02d7ba5b253ddeee',
    byteLength: 1080
  }
] as const

function readBundleFile(relativePath: string): string {
  return fs.readFileSync(path.join(BUNDLE_ROOT, relativePath), 'utf8')
}

describe('homebrew emulator package layout', () => {
  it('ships one verified runtime bundle and keeps provenance/legal files unservable', () => {
    const bundle = loadEmulatorAssetBundle(BUNDLE_ROOT)
    expect(bundle.manifest).toEqual({
      schemaVersion: 1,
      gameId: 'homebrew-demo',
      entryPath: 'index.html',
      assets: EXPECTED_ASSETS
    })
    expect(bundle.manifest.assets.map((asset) => asset.path)).not.toContain('emulator-package.json')
    const registry = createEmulatorAssetRegistry([bundle])
    for (const expected of EXPECTED_ASSETS) {
      const resolved = resolveEmulatorAsset(
        registry,
        emulatorAssetUrl('homebrew-demo', expected.path)
      )
      expect(resolved).toMatchObject({ assetPath: expected.path, mimeType: expected.mimeType })
      expect(resolved?.bytes.byteLength).toBe(expected.byteLength)
      expect(sha256Hex(resolved?.bytes ?? Buffer.alloc(0))).toBe(expected.sha256)
    }
    for (const protectedPath of [
      'manifest.json',
      'emulator-package.json',
      'component-provenance.json',
      'LICENSES/SameBoy-libretro-MIT.txt',
      'LICENSES/Libretro-common-MIT.txt',
      'LICENSES/Emscripten-MIT-AND-NCSA.txt',
      'LICENSES/TaskWraith-fixture-MIT.txt'
    ]) {
      expect(
        resolveEmulatorAsset(registry, emulatorAssetUrl('homebrew-demo', protectedPath))
      ).toBeNull()
    }

    const statePackage = loadEmulatorPackageManifest(BUNDLE_ROOT)
    expect(validateTwgbHomebrewDemoPackage(statePackage, bundle)).toMatchObject({
      schemaVersion: 2,
      coreId: 'sameboy-libretro',
      coreSha256: 'd22bc58f152733c8731c17348a1b1ff1f99384fd146784a8f58793419be46611',
      runtimeWasmSha256: 'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf',
      romSha256: '2175c6b758fdd76e4e878ccf10ee04f50135be74226f548df78dff4fea5806c7',
      stateAdapter: {
        schemaVersion: 2,
        stateWindow: { source: 'system_ram', startAddress: 49408, byteLength: 13 },
        fields: [
          { key: 'x', read: { address: 6, encoding: 'u8' }, unit: 'px' },
          { key: 'y', read: { address: 7, encoding: 'u8' }, unit: 'px' },
          { key: 'input', read: { address: 8, encoding: 'u8' }, unit: 'mask' },
          { key: 'frame-counter', read: { address: 9, encoding: 'u32le' }, unit: 'frames' }
        ]
      }
    })

    const provenance = JSON.parse(readBundleFile('component-provenance.json')) as {
      bundle: {
        artifacts: unknown[]
        runtimeManifest: { byteLength: number; path: string; sha256: string }
        statePackage: {
          byteLength: number
          coreSha256: string
          path: string
          romSha256: string
          runtimeWasmSha256: string
          schemaVersion: number
          sha256: string
          stateAdapterSchemaSha256: string
        }
      }
      components: Array<{
        embeddedArtifacts: string[]
        id: string
        license: null | { byteLength: number; path: string; sha256: string; spdx: string }
      }>
      sourceReceipt: { commit: string; path: string; sha256: string }
      validationOnly: { sameboy: { commit: string; version: string } }
    }
    expect(provenance.sourceReceipt).toEqual({
      commit: 'e57e122dc282f87420e52f506092967b6717fc2a',
      path: 'scripts/emulator/build-receipt.json',
      sha256: 'ba354d0732ca21431122754a701f027a96a2453ef0a8b30b0ab5ca8c2ba47df3'
    })
    expect(provenance.validationOnly.sameboy).toMatchObject({
      commit: '208ba4afabffab9edde416f2dbb8ae459e34adb8',
      version: '1.0.3'
    })
    expect(provenance.bundle.runtimeManifest).toEqual({
      path: 'manifest.json',
      sha256: '535a00bb271552b0577f7379ded8bfe40746773d0323ee5953e6a8bd57aec61e',
      byteLength: 1040
    })
    expect(provenance.bundle.statePackage).toEqual({
      path: 'emulator-package.json',
      sha256: '632243f233a8a94c53a73c4bd0c7322fe183fd8f8278d65f1fb1aa9c11e52e9a',
      byteLength: 1394,
      schemaVersion: 2,
      coreSha256: 'd22bc58f152733c8731c17348a1b1ff1f99384fd146784a8f58793419be46611',
      runtimeWasmSha256: 'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf',
      romSha256: '2175c6b758fdd76e4e878ccf10ee04f50135be74226f548df78dff4fea5806c7',
      stateAdapterSchemaSha256: '3555c44a29fcd601c5800d2984e4a64fc6f74b709d53f7145cf0153e52030925'
    })
    expect(provenance.bundle.artifacts).toEqual([
      {
        path: 'twgb.mjs',
        sha256: '01550656c449f123de6f6519c0820433c3d48c1a9496e20d0a4d2dc6ffe26d6c',
        byteLength: 64092
      },
      {
        path: 'twgb.wasm',
        sha256: 'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf',
        byteLength: 214835
      }
    ])
    expect(provenance.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sameboy-libretro',
          embeddedArtifacts: ['twgb.wasm'],
          license: expect.objectContaining({
            path: 'LICENSES/SameBoy-libretro-MIT.txt',
            sha256: '00b4b03270ea21b70b4b51fbc93c6eb43876e46ceb742e74918e459ea2481f21'
          })
        }),
        expect.objectContaining({
          id: 'libretro-common',
          embeddedArtifacts: ['twgb.wasm'],
          license: expect.objectContaining({ path: 'LICENSES/Libretro-common-MIT.txt' })
        }),
        expect.objectContaining({
          id: 'emscripten-runtime',
          embeddedArtifacts: ['twgb.mjs', 'twgb.wasm'],
          license: expect.objectContaining({ path: 'LICENSES/Emscripten-MIT-AND-NCSA.txt' })
        }),
        expect.objectContaining({
          id: 'taskwraith-fixture',
          embeddedArtifacts: ['twgb.wasm'],
          license: expect.objectContaining({ path: 'LICENSES/TaskWraith-fixture-MIT.txt' })
        })
      ])
    )
    for (const expected of EXPECTED_COMPONENT_LICENSES) {
      const component = provenance.components.find((candidate) => candidate.id === expected.id)
      expect(component?.license).toEqual({
        spdx: expected.spdx,
        path: expected.path,
        sha256: expected.sha256,
        byteLength: expected.byteLength
      })
    }
    expect(JSON.stringify(provenance)).not.toMatch(/\b(?:rgbds|cppp)\b/i)
  })

  it('maps the bundle once outside app.asar and resolves dev and packaged roots', () => {
    const builder = fs.readFileSync(path.join(REPOSITORY_ROOT, 'electron-builder.yml'), 'utf8')
    const filesBlock = /files:\n([\s\S]*?)\n# All platforms:/.exec(builder)?.[1]
    const extraResourcesBlock = /extraResources:\n([\s\S]*?)\nasarUnpack:/.exec(builder)?.[1]
    expect(filesBlock).toContain('!resources/emulator/**')
    expect(extraResourcesBlock).toMatch(
      /- from: resources\/emulator\n {4}to: emulator\n {4}filter:\n {6}- '\*\*\/\*'/
    )
    expect(builder.match(/from: resources\/emulator/g)).toHaveLength(1)
    expect(filesBlock).not.toMatch(/^\s*-\s+'resources\/emulator\//m)
    expect(
      emulatorAssetRoot({
        appPath: '/repo',
        resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
        isPackaged: false
      })
    ).toBe('/repo/resources/emulator')
    expect(
      emulatorAssetRoot({
        appPath: '/repo',
        resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
        isPackaged: true
      })
    ).toBe('/Applications/TaskWraith.app/Contents/Resources/emulator')
  })

  it('keeps the browser facade strict, serialized, and protocol-CSP-governed', () => {
    const index = readBundleFile('index.html')
    const bootstrap = readBundleFile('bootstrap.mjs')
    expect(index).toContain('<link rel="stylesheet" href="./style.css" />')
    expect(index).toContain('<script type="module" src="./bootstrap.mjs"></script>')
    expect(index).toContain('id="play-pause"')
    expect(index).toContain('aria-pressed="false"')
    expect(index).toContain('id="controls-hint"')
    expect(index).toContain('tabindex="0"')
    expect(index).not.toContain('Content-Security-Policy')
    expect(index).not.toMatch(/<style\b|<script(?![^>]*\bsrc=)/i)
    expect(EMULATOR_DOCUMENT_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(bootstrap).toContain('const TWGB_SCHEMA = 1')
    expect(bootstrap).toContain('abi.status === READY_STATUS')
    expect(bootstrap).toContain('abi.input === 0')
    expect(bootstrap).toContain('abi.frameCounter > 0')
    expect(bootstrap).toContain('Unsupported twemu button')
    expect(bootstrap).toContain('Duplicate twemu button')
    expect(bootstrap).toContain('opposite direction pairs')
    expect(bootstrap).toContain('function enqueueOperation(operation)')
    expect(bootstrap).toContain(
      'return enqueueOperation(() => stepOneFrame(buttons, expectedFrameId, expectedInputEpoch))'
    )
    expect(bootstrap).toContain('await yieldToEventLoop()')
    expect(bootstrap).toContain("screen.toDataURL('image/png')")
    expect(bootstrap).toContain('pngDataUrl')
    expect(bootstrap).toContain('trustedHumanInputEpoch')
    expect(bootstrap).toContain('readyForHumanPlay')
    expect(bootstrap).toContain('requestAnimationFrame')
    expect(bootstrap).toContain('humanFrameQueued')
    expect(bootstrap).toContain("return 'user_active'")
    expect(bootstrap).toContain('framesAdvanced: 0')
    expect(bootstrap).toContain('framesAdvanced: 1')
    expect(bootstrap).toContain('assertRuntimeHealthy()')
    expect(bootstrap).toContain('event.isTrusted !== true')
    expect(bootstrap).toContain('event.isTrusted !== true')
    expect(bootstrap).toContain("kind: 'refusal'")
    expect(bootstrap).toContain("return 'stale_observation'")
    expect(bootstrap).toContain("return 'stale_input_epoch'")
    expect(bootstrap).toContain('Framebuffer lies outside the Emscripten heap')
    expect(bootstrap).toContain('source.byteLength !== byteLength')
    expect(bootstrap).toContain('Number.isSafeInteger(ramPointer)')
    expect(bootstrap).toContain('Number.isSafeInteger(ramSize)')
    expect(bootstrap).toContain('Number.isSafeInteger(pointer)')
    expect(bootstrap).toContain('Object.freeze({')
    expect(bootstrap).toContain("Object.defineProperty(globalThis, '__twemu'")
    expect(bootstrap).toContain('configurable: false')
    expect(bootstrap).toContain('writable: false')
    expect(bootstrap).toContain('let moduleInstance = null')
    expect(bootstrap).not.toMatch(/globalThis\.(?:moduleInstance|HEAPU8)/)
    expect(readBundleFile('style.css')).toContain('#screen:focus-visible')
    expect(bootstrap).toMatch(
      /async shutdown\(\) \{\s+await readyPromise\.catch\(\(\) => undefined\)\s+\/\/ Cancel the human loop[\s\S]+?readyForHumanPlay = false\s+stopHumanPlay\(\)\s+return enqueueOperation\(shutdownInternal\)/
    )
  })

  it('ignores only the generated module while authored browser files remain Prettier-clean', async () => {
    const generatedModule = path.join(BUNDLE_ROOT, 'twgb.mjs')
    const generatedInfo = await prettier.getFileInfo(generatedModule, {
      ignorePath: path.join(REPOSITORY_ROOT, '.prettierignore')
    })
    expect(generatedInfo.ignored).toBe(true)
    for (const relativePath of [
      'index.html',
      'style.css',
      'bootstrap.mjs',
      'manifest.json',
      'emulator-package.json',
      'component-provenance.json'
    ]) {
      const filePath = path.join(BUNDLE_ROOT, relativePath)
      const options = (await prettier.resolveConfig(filePath)) ?? {}
      expect(
        await prettier.check(fs.readFileSync(filePath, 'utf8'), { ...options, filepath: filePath })
      ).toBe(true)
    }
  })
})
