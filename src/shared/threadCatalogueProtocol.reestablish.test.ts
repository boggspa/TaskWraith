import { describe, expect, it } from 'vitest'
import {
  decodeThreadCatalogueMaintenanceQuery,
  decodeThreadCatalogueReadQuery
} from './threadCatalogueProtocol'

describe('reestablish-erasure on the wire', () => {
  it('decodes a chat-scoped and a global resume', () => {
    expect(
      decodeThreadCatalogueMaintenanceQuery({
        method: 'reestablish-erasure',
        chatId: 'chat-1',
        generation: 'g-1'
      })
    ).toEqual({ method: 'reestablish-erasure', chatId: 'chat-1', generation: 'g-1' })
    expect(
      decodeThreadCatalogueMaintenanceQuery({ method: 'reestablish-erasure', generation: 'g-1' })
    ).toEqual({ method: 'reestablish-erasure', generation: 'g-1' })
  })

  it('refuses a resume with no usable generation or an unsafe chat id', () => {
    expect(decodeThreadCatalogueMaintenanceQuery({ method: 'reestablish-erasure' })).toBeNull()
    expect(
      decodeThreadCatalogueMaintenanceQuery({ method: 'reestablish-erasure', generation: '' })
    ).toBeNull()
    expect(
      decodeThreadCatalogueMaintenanceQuery({
        method: 'reestablish-erasure',
        chatId: '../escape',
        generation: 'g-1'
      })
    ).toBeNull()
  })

  it('keeps finish-erasure decoding as it was', () => {
    expect(
      decodeThreadCatalogueMaintenanceQuery({
        method: 'finish-erasure',
        chatId: 'chat-1',
        generation: 'g-1'
      })
    ).toEqual({ method: 'finish-erasure', chatId: 'chat-1', generation: 'g-1' })
  })

  it('never travels the read-only surface', () => {
    expect(
      decodeThreadCatalogueReadQuery({
        method: 'reestablish-erasure',
        chatId: 'chat-1',
        generation: 'g-1'
      })
    ).toBeNull()
  })
})
