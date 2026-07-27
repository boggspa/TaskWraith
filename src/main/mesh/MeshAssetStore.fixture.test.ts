/**
 * Opt-in integration coverage for a real user-supplied DCC export.
 *
 * Run with `TASKWRAITH_MESH_FIXTURE=/absolute/path/to/model.obj` (or .glb/.gltf).
 * The fixture is copied only to a temporary private vault and is never modified.
 * CI deliberately skips this test when no local fixture is supplied.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MeshAssetStore } from './MeshAssetStore'

const fixturePath = process.env.TASKWRAITH_MESH_FIXTURE?.trim() || null
const hasFixture = Boolean(fixturePath && fs.existsSync(fixturePath))

describe('MeshAssetStore local fixture import', () => {
  it.skipIf(!hasFixture)(
    'copies an explicitly selected local model into a private, token-gated vault',
    () => {
      if (!fixturePath) throw new Error('TASKWRAITH_MESH_FIXTURE is required for this test.')
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-fixture-'))
      try {
        const realFixture = fs.realpathSync(fixturePath)
        const sourceStat = fs.statSync(realFixture)
        const assets = new MeshAssetStore(path.join(root, 'assets'))
        const manifest = assets.importModel(realFixture).manifest

        expect(manifest.kind).toBe('model')
        expect(manifest.entryPath).toBe(path.basename(realFixture))
        expect(manifest.files).toContain(manifest.entryPath)
        expect(manifest.byteLength).toBeGreaterThanOrEqual(sourceStat.size)

        if (path.extname(realFixture).toLowerCase() === '.obj') {
          const declaresMaterialLibrary = /^\s*mtllib\s+/im.test(
            fs.readFileSync(realFixture, 'utf8')
          )
          if (declaresMaterialLibrary) {
            expect(manifest.files.some((entry) => entry.toLowerCase().endsWith('.mtl'))).toBe(true)
          }
        }

        const resolved = assets.resolveAssetFile({
          assetId: manifest.id,
          accessToken: manifest.accessToken,
          relativePath: manifest.entryPath
        })
        expect(resolved?.byteLength).toBe(sourceStat.size)
        expect(
          resolved?.filePath.startsWith(fs.realpathSync(path.join(root, 'assets', manifest.id)))
        ).toBe(true)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
