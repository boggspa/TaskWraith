import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { protocol } from 'electron'
import { meshAssetUrl } from '../../shared/meshScene'
import { MeshAssetStore } from './MeshAssetStore'
import { registerMeshAssetProtocol } from './MeshAssetProtocol'

vi.mock('electron', () => ({
  protocol: { handle: vi.fn() }
}))

type ProtocolHandler = (request: Request) => Promise<Response>

function handler(): ProtocolHandler {
  const registered = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as
    | ProtocolHandler
    | undefined
  expect(registered).toBeTypeOf('function')
  if (!registered) throw new Error('twmesh protocol handler was not registered')
  return registered
}

describe('registerMeshAssetProtocol', () => {
  let root: string
  let source: string
  let store: MeshAssetStore

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mesh-protocol-'))
    source = path.join(root, 'fixture.obj')
    fs.writeFileSync(source, 'v 0 0 0\n')
    store = new MeshAssetStore(path.join(root, 'vault'))
    vi.mocked(protocol.handle).mockReset()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('serves only a token-authorised vault entry without exposing a filesystem URL', async () => {
    const asset = store.importModel(source).manifest
    const url = meshAssetUrl({
      assetId: asset.id,
      accessToken: asset.accessToken,
      relativePath: asset.entryPath
    })
    expect(url).toMatch(/^twmesh:\/\/asset\//)
    registerMeshAssetProtocol(store)

    const response = await handler()(new Request(url!))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('model/obj')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('v 0 0 0\n')
  })

  it('returns one opaque failure for bad tokens, traversal, and writes', async () => {
    const asset = store.importModel(source).manifest
    registerMeshAssetProtocol(store)
    const registered = handler()
    const invalidToken = await registered(
      new Request(`twmesh://asset/${asset.id}/${'0'.repeat(64)}/${asset.entryPath}`)
    )
    const traversal = await registered(
      new Request(`twmesh://asset/${asset.id}/${asset.accessToken}/../manifest.json`)
    )
    const write = await registered(
      new Request(`twmesh://asset/${asset.id}/${asset.accessToken}/${asset.entryPath}`, {
        method: 'POST'
      })
    )
    expect([invalidToken.status, traversal.status, write.status]).toEqual([404, 404, 404])
  })
})
