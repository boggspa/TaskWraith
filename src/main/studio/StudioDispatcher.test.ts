import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEditCommittedNotification, handleStudioMessage } from './StudioDispatcher'
import {
  STUDIO_ERROR_NUMBERS,
  STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
  STUDIO_PROPOSAL_SCHEMA_VERSION,
  STUDIO_METHODS,
  STUDIO_PROTOCOL_VERSION,
  StudioNdjsonDecoder,
  encodeStudioMessage,
  type StudioErrorResponseMessage,
  type StudioInsertRangeOp,
  type StudioSuccessResponseMessage
} from './StudioProtocol'
import { StudioRevisionStore, type StudioRevisionStoreOptions } from './StudioRevisionStore'

const temporaryDirectories: string[] = []

async function openStore(options: StudioRevisionStoreOptions = {}): Promise<StudioRevisionStore> {
  const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-dispatcher-'))
  temporaryDirectories.push(directory)
  return StudioRevisionStore.open(directory, options)
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

const insertOp: StudioInsertRangeOp = {
  type: 'insert_range',
  itemId: 'item-1',
  assetId: 'asset-1',
  sourceIn: { n: 0, d: 30000 },
  sourceOut: { n: 30030, d: 30000 },
  at: { n: 0, d: 1 }
}

const insertRangeParams = { baseRevision: 0, op: insertOp }

describe('StudioDispatcher', () => {
  it('answers hello with the protocol version and current revision', async () => {
    const store = await openStore()
    const response = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 1,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: STUDIO_PROTOCOL_VERSION }
    })) as StudioSuccessResponseMessage
    expect(response.result).toMatchObject({ protocolVersion: 1, revision: 0 })
    await store.close()
  })

  it('rejects an unsupported protocol version with the supported list', async () => {
    const store = await openStore()
    const response = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 2,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 99 }
    })) as StudioErrorResponseMessage
    expect(response.error.data.studioCode).toBe('unsupported_protocol_version')
    expect(response.error.data.supported).toEqual([STUDIO_PROTOCOL_VERSION])
    await store.close()
  })

  it('applies an edit then rejects the same base as stale with currentRevision', async () => {
    const store = await openStore()
    const applied = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 3,
      method: STUDIO_METHODS.applyEdit,
      params: insertRangeParams
    })) as StudioSuccessResponseMessage
    expect(applied.result).toEqual({ revision: 1 })

    const stale = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 4,
      method: STUDIO_METHODS.applyEdit,
      params: { ...insertRangeParams, op: { ...insertOp, itemId: 'item-2' } }
    })) as StudioErrorResponseMessage
    expect(stale.error.code).toBe(STUDIO_ERROR_NUMBERS.stale_base)
    expect(stale.error.data).toMatchObject({ studioCode: 'stale_base', currentRevision: 1 })

    const fetched = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 5,
      method: STUDIO_METHODS.getDocument
    })) as StudioSuccessResponseMessage
    expect(fetched.result).toMatchObject({ revision: 1 })
    await store.close()
  })

  it('opens media with a versioned payload, returns identity and persists the document asset', async () => {
    const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-open-media-'))
    temporaryDirectories.push(directory)
    const mediaPath = nodePath.join(directory, 'clip.mov')
    await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')
    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [directory] })

    const opened = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 10,
      method: STUDIO_METHODS.openMedia,
      params: {
        schemaVersion: STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
        baseRevision: 0,
        assetId: 'asset-clip',
        path: mediaPath,
        mediaKind: 'video'
      }
    })) as StudioSuccessResponseMessage
    expect(opened.result).toMatchObject({
      schemaVersion: STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
      revision: 1,
      asset: { assetId: 'asset-clip', mediaKind: 'video' }
    })
    const canonicalPath = await fsPromises.realpath(mediaPath)
    expect((opened.result as { asset: { path: string } }).asset.path).toBe(canonicalPath)

    const fetched = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 11,
      method: STUDIO_METHODS.getDocument
    })) as StudioSuccessResponseMessage
    expect(fetched.result).toMatchObject({
      revision: 1,
      document: { assets: [{ assetId: 'asset-clip', path: canonicalPath, mediaKind: 'video' }] }
    })

    const stale = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 12,
      method: STUDIO_METHODS.openMedia,
      params: {
        schemaVersion: STUDIO_OPEN_MEDIA_SCHEMA_VERSION,
        baseRevision: 0,
        assetId: 'asset-other',
        path: mediaPath,
        mediaKind: 'video'
      }
    })) as StudioErrorResponseMessage
    expect(stale.error.data).toMatchObject({ studioCode: 'stale_base', currentRevision: 1 })
    await store.close()
  })

  it('proposes insert_range as a durable ghost and applies it only on acceptance', async () => {
    const store = await openStore()
    const proposed = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 20,
      method: STUDIO_METHODS.proposeEdit,
      params: {
        schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
        baseRevision: 0,
        proposalId: 'proposal-1',
        op: insertOp
      }
    })) as StudioSuccessResponseMessage
    expect(proposed.result).toMatchObject({
      schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
      revision: 1,
      proposal: { proposalId: 'proposal-1', createdRevision: 1 }
    })

    const ghost = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 21,
      method: STUDIO_METHODS.getDocument
    })) as StudioSuccessResponseMessage
    expect(ghost.result).toMatchObject({
      revision: 1,
      document: { proposals: [{ proposalId: 'proposal-1' }], tracks: [] }
    })

    const accepted = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 22,
      method: STUDIO_METHODS.resolveProposal,
      params: {
        schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
        baseRevision: 1,
        proposalId: 'proposal-1',
        decision: 'accept'
      }
    })) as StudioSuccessResponseMessage
    expect(accepted.result).toMatchObject({
      schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
      revision: 2,
      proposalId: 'proposal-1',
      decision: 'accept',
      appliedOp: { itemId: 'item-1' }
    })
    expect(store.getDocument()).toMatchObject({
      proposals: [],
      tracks: [{ items: [{ itemId: 'item-1' }] }]
    })
    await store.close()
  })

  it('rejects unsupported proposal schemas before mutating durable state', async () => {
    const store = await openStore()
    const response = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 23,
      method: STUDIO_METHODS.proposeEdit,
      params: {
        schemaVersion: 99,
        baseRevision: 0,
        proposalId: 'proposal-1',
        op: insertOp
      }
    })) as StudioErrorResponseMessage
    expect(response.error.data.studioCode).toBe('invalid_params')
    expect(store.revision).toBe(0)
    expect(store.getDocument().proposals).toEqual([])
    await store.close()
  })

  it('rejects malformed params, unknown methods and invalid envelopes', async () => {
    const store = await openStore()
    const badParams = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 6,
      method: STUDIO_METHODS.applyEdit,
      params: { baseRevision: 'zero' }
    })) as StudioErrorResponseMessage
    expect(badParams.error.data.studioCode).toBe('invalid_params')

    const unknown = (await handleStudioMessage(store, {
      jsonrpc: '2.0',
      id: 7,
      method: 'studio/unknown'
    })) as StudioErrorResponseMessage
    expect(unknown.error.data.studioCode).toBe('method_not_found')

    const invalid = (await handleStudioMessage(store, { id: 8 })) as StudioErrorResponseMessage
    expect(invalid.error.data.studioCode).toBe('invalid_request')
    expect(invalid.id).toBeNull()

    const notification = await handleStudioMessage(store, {
      jsonrpc: '2.0',
      method: 'studio/editCommitted'
    })
    expect(notification).toBeNull()
    await store.close()
  })

  it('round-trips request and response through the NDJSON codec', async () => {
    const store = await openStore()
    const decoder = new StudioNdjsonDecoder()
    const wireRequest = encodeStudioMessage({
      jsonrpc: '2.0',
      id: 9,
      method: STUDIO_METHODS.applyEdit,
      params: insertRangeParams
    })
    const [decoded] = decoder.push(wireRequest)
    expect(decoded.kind).toBe('message')
    if (decoded.kind !== 'message') throw new Error('expected a decoded message')
    const response = await handleStudioMessage(store, decoded.value)
    if (response === null) throw new Error('expected a response')
    const [echoed] = new StudioNdjsonDecoder().push(encodeStudioMessage(response))
    expect(echoed.kind).toBe('message')
    if (echoed.kind === 'message') {
      expect((echoed.value as StudioSuccessResponseMessage).result).toEqual({ revision: 1 })
    }
    await store.close()
  })

  it('builds editCommitted notifications for the future transport slice', () => {
    const note = buildEditCommittedNotification(3, insertOp)
    expect(note.method).toBe(STUDIO_METHODS.editCommitted)
    expect(note.params).toMatchObject({ revision: 3 })
  })
})
