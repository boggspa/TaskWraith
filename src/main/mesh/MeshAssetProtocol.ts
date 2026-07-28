/**
 * Token-gated `twmesh://` serving for private Mesh Canvas asset bundles.
 *
 * URLs contain only an opaque asset id, capability token, and vault-relative
 * dependency path. They never expose a source or vault filesystem path. The
 * MeshAssetStore validates all three before this handler opens a verified fd.
 */
import * as fs from 'fs'
import { Readable } from 'stream'
import { protocol } from 'electron'
import { isSafeMeshAssetRelativePath } from '../../shared/meshScene'
import type { MeshAssetStore } from './MeshAssetStore'

export const MESH_ASSET_SCHEME = 'twmesh'

export const MESH_ASSET_PRIVILEGE = {
  scheme: MESH_ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    bypassCSP: false,
    // Three's GLTF/OBJ loaders use fetch/XHR from the renderer origin. The
    // resource remains capability-gated by its opaque URL token; CORS support
    // merely lets that local renderer consume its own private asset bundle.
    corsEnabled: true
  }
} as const

interface MeshAssetUrlParts {
  assetId: string
  accessToken: string
  relativePath: string
}

function parseMeshAssetUrl(value: string): MeshAssetUrlParts | null {
  try {
    const url = new URL(value)
    if (url.protocol !== `${MESH_ASSET_SCHEME}:` || url.hostname !== 'asset') return null
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
    const [assetId, accessToken, ...pathSegments] = segments
    const relativePath = pathSegments.join('/')
    if (!assetId || !accessToken || !isSafeMeshAssetRelativePath(relativePath)) return null
    return { assetId, accessToken, relativePath }
  } catch {
    return null
  }
}

function notFound(): Response {
  // Deliberately do not distinguish malformed, missing, expired, or unauthorised
  // capabilities: the protocol is not an existence oracle.
  return new Response('Not found', { status: 404 })
}

function sameOpenedFile(before: fs.Stats, opened: fs.Stats): boolean {
  return (
    before.isFile() && opened.isFile() && before.dev === opened.dev && before.ino === opened.ino
  )
}

/** Register after Electron is ready; scheme privilege must be registered pre-ready. */
export function registerMeshAssetProtocol(store: MeshAssetStore): void {
  protocol.handle(MESH_ASSET_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()
    const parts = parseMeshAssetUrl(request.url)
    if (!parts) return notFound()
    const asset = store.resolveAssetFile(parts)
    if (!asset) return notFound()

    let fd: number | null = null
    try {
      const before = fs.lstatSync(asset.filePath)
      if (!before.isFile() || before.isSymbolicLink()) return notFound()
      fd = fs.openSync(asset.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const opened = fs.fstatSync(fd)
      if (!sameOpenedFile(before, opened)) return notFound()
      const headers = {
        'Content-Type': asset.mimeType,
        'Content-Length': String(opened.size),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })

      // Keep small textures and OBJ/MTL sidecars on the reliable Buffer path;
      // large GLB payloads stay streamed from this verified descriptor.
      if (opened.size <= 8 * 1024 * 1024) {
        const body = fs.readFileSync(fd)
        return new Response(body as unknown as BodyInit, { status: 200, headers })
      }
      const stream = fs.createReadStream(asset.filePath, { fd, autoClose: true })
      fd = null // stream now owns the descriptor
      return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status: 200, headers })
    } catch {
      return notFound()
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  })
}
