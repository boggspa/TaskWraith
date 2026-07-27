import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MESH_SCENE_PACKAGE_KIND,
  MESH_SCENE_PACKAGE_MANIFEST_FILE
} from '../../shared/meshScenePackage'
import { resolveMeshScenePackage } from './MeshScenePackageResolver'

const roots: string[] = []

function makePackage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scene-package-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'scene', 'materials'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'scene', 'world.gltf'),
    JSON.stringify({ buffers: [{ uri: 'world.bin' }], images: [{ uri: 'materials/wall.png' }] })
  )
  fs.writeFileSync(path.join(root, 'scene', 'world.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(
    path.join(root, 'scene', 'materials', 'wall.png'),
    Buffer.from([137, 80, 78, 71])
  )
  const manifestPath = path.join(root, MESH_SCENE_PACKAGE_MANIFEST_FILE)
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: MESH_SCENE_PACKAGE_KIND,
      title: 'World export',
      roots: [{ path: 'scene/world.gltf', name: 'World' }],
      files: ['scene/world.gltf', 'scene/world.bin', 'scene/materials/wall.png']
    })
  )
  return manifestPath
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveMeshScenePackage', () => {
  it('resolves only the manifest-declared local files and validates glTF dependencies', () => {
    const manifestPath = makePackage()
    const resolved = resolveMeshScenePackage(manifestPath)

    expect(resolved).toMatchObject({
      title: 'World export',
      roots: [{ path: 'scene/world.gltf', name: 'World', format: 'gltf' }]
    })
    expect(resolved.files.map((file) => file.relativePath)).toEqual([
      'scene/world.gltf',
      'scene/world.bin',
      'scene/materials/wall.png'
    ])
    const packageRoot = fs.realpathSync(path.dirname(manifestPath))
    expect(resolved.files.every((file) => file.sourcePath.startsWith(packageRoot))).toBe(true)
  })

  it('rejects a scene dependency that the exporter did not declare', () => {
    const manifestPath = makePackage()
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] }
    manifest.files = ['scene/world.gltf', 'scene/world.bin']
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => resolveMeshScenePackage(manifestPath)).toThrow(/wall\.png.*must be declared/)
  })

  it('requires the exact declarative package manifest file name', () => {
    const manifestPath = makePackage()
    expect(() =>
      resolveMeshScenePackage(manifestPath.replace('taskwraith.mesh-scene.json', 'scene.json'))
    ).toThrow(/taskwraith\.mesh-scene\.json/)
  })

  it('rejects an unsafe sidecar reference instead of following it outside the package', () => {
    const manifestPath = makePackage()
    fs.writeFileSync(
      path.join(path.dirname(manifestPath), 'scene', 'world.gltf'),
      JSON.stringify({ buffers: [{ uri: 'https://example.invalid/world.bin' }] })
    )

    expect(() => resolveMeshScenePackage(manifestPath)).toThrow(/not a safe local path/)
  })

  it('rejects symlinked declared files', () => {
    const manifestPath = makePackage()
    const packageRoot = path.dirname(manifestPath)
    const linked = path.join(packageRoot, 'scene', 'world.bin')
    fs.rmSync(linked)
    fs.symlinkSync(path.join(packageRoot, 'scene', 'world.gltf'), linked)

    expect(() => resolveMeshScenePackage(manifestPath)).toThrow(/must be a regular file/)
  })
})
