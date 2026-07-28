import { describe, expect, it } from 'vitest'
import {
  MESH_SCENE_PACKAGE_KIND,
  MESH_SCENE_PACKAGE_MANIFEST_FILE,
  MeshScenePackageManifestError,
  isMeshScenePackageManifestFileName,
  parseMeshScenePackageManifest
} from './meshScenePackage'

describe('parseMeshScenePackageManifest', () => {
  it('normalizes a data-only package that contains complete exported scene roots', () => {
    expect(
      parseMeshScenePackageManifest({
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        title: '  Gallery export  ',
        roots: [{ path: 'scene/gallery.gltf', name: 'Gallery' }, { path: 'props/sign.obj' }],
        files: [
          'scene/gallery.gltf',
          'scene/gallery.bin',
          'textures/wall.webp',
          'props/sign.obj',
          'props/sign.mtl',
          'props/sign.png'
        ],
        exporterMetadata: { application: 'Blender', version: '5.0' }
      })
    ).toEqual({
      schemaVersion: 1,
      kind: MESH_SCENE_PACKAGE_KIND,
      title: 'Gallery export',
      roots: [
        { path: 'scene/gallery.gltf', name: 'Gallery', format: 'gltf' },
        { path: 'props/sign.obj', format: 'obj' }
      ],
      files: [
        'scene/gallery.gltf',
        'scene/gallery.bin',
        'textures/wall.webp',
        'props/sign.obj',
        'props/sign.mtl',
        'props/sign.png'
      ]
    })
  })

  it.each([
    [
      'path traversal',
      {
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        roots: [{ path: '../scene.glb' }],
        files: ['../scene.glb']
      },
      /safe relative/
    ],
    [
      'unsupported native project root',
      {
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        roots: [{ path: 'project/scene.blend' }],
        files: ['project/scene.blend']
      },
      /\.glb, \.gltf, or \.obj/
    ],
    [
      'undeclared root',
      {
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        roots: [{ path: 'scene.glb' }],
        files: ['texture.png']
      },
      /must also appear in files/
    ],
    [
      'duplicate package file',
      {
        schemaVersion: 1,
        kind: MESH_SCENE_PACKAGE_KIND,
        roots: [{ path: 'scene.glb' }],
        files: ['scene.glb', 'scene.glb']
      },
      /must not contain duplicates/
    ]
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseMeshScenePackageManifest(value)).toThrow(MeshScenePackageManifestError)
    expect(() => parseMeshScenePackageManifest(value)).toThrow(message)
  })
})

describe('isMeshScenePackageManifestFileName', () => {
  it('matches only the exact package root manifest name', () => {
    expect(isMeshScenePackageManifestFileName(MESH_SCENE_PACKAGE_MANIFEST_FILE)).toBe(true)
    expect(isMeshScenePackageManifestFileName(`/exports/${MESH_SCENE_PACKAGE_MANIFEST_FILE}`)).toBe(
      true
    )
    expect(isMeshScenePackageManifestFileName('random.json')).toBe(false)
  })
})
