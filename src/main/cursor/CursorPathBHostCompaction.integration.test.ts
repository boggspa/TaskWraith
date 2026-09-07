import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const requestStart = indexSource.indexOf('async function compactProviderContextForRequest(')
const reservedStart = indexSource.indexOf(
  'async function compactProviderContextForReservedRequest('
)
const requestSource = indexSource.slice(requestStart, reservedStart)
const reservedSource = indexSource.slice(reservedStart, reservedStart + 16_000)

describe('Cursor Path-B host compaction production wiring', () => {
  it('reserves before the Path-B host compact and does not early-return unimplemented', () => {
    expect(requestSource.includes('maintenanceCompactionRegistry.reserve({')).toBe(true)
    expect(
      requestSource.includes(
        'Cursor host-seat compaction is not implemented for Path-B sandbox runs yet'
      )
    ).toBe(false)
    expect(requestSource.includes('await compactProviderContextForReservedRequest(')).toBe(true)
  })

  it('dispatches reserved Cursor requests to the extracted Path-B host compact', () => {
    expect(indexSource.includes("from './cursor/CursorPathBHostCompaction'")).toBe(true)
    expect(reservedSource.includes('compactCursorPathBHostContext(')).toBe(true)
    expect(reservedSource.includes('appendDurableRunEventForRoute(')).toBe(true)
    expect(
      reservedSource.includes(
        'Cursor host-seat compaction is not implemented for Path-B sandbox runs yet'
      )
    ).toBe(false)
    expect(reservedSource.includes("payload.provider !== 'cursor'")).toBe(true)
  })
})
