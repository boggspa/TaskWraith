import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLegacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import {
  DESKTOP_WRITER_FENCE_PURPOSE,
  persistLegacyStoreWriterGate,
  readDesktopWriterFence
} from './LegacyStoreWriterGatePersistence'
import {
  LEGACY_IN_PROCESS_CUTOVER_ID,
  LEGACY_IN_PROCESS_HOST_ID,
  drainLegacyStoreForInProcessHost
} from './LegacyInProcessHostWriter'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'legacy-in-process-host-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('drainLegacyStoreForInProcessHost', () => {
  it('drains AppStore writers and marks the in-process Host as owner', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    const lease = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    let drained = false
    const waiting = drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate }).then(() => {
      drained = true
    })
    expect(drained).toBe(false)
    expect(gate.snapshot().state).toBe('draining')
    expect(readDesktopWriterFence(profilePath)).toMatchObject({ state: 'draining' })
    expect(lease.release()).toBe(true)
    await waiting
    expect(gate.snapshot()).toMatchObject({
      state: 'host-owned',
      hostOwned: true,
      ownership: {
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID
      }
    })
    expect(readDesktopWriterFence(profilePath)).toEqual({
      schemaVersion: 1,
      purpose: DESKTOP_WRITER_FENCE_PURPOSE,
      state: 'host-owned',
      ownership: {
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID
      }
    })
    expect(gate.admit({ operation: 'save', pathFamily: 'chats' })).toBeNull()
  })

  it('is a no-op when the gate is already host-owned', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    expect(gate.beginDrain()).toBe(true)
    expect(
      gate.markHostOwned({ hostId: 'existing-host', generation: 4, cutoverId: 'cutover-existing' })
    ).toBe(true)
    await drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate })
    expect(gate.snapshot().ownership).toEqual({
      hostId: 'existing-host',
      generation: 4,
      cutoverId: 'cutover-existing'
    })
    expect(readDesktopWriterFence(profilePath)).toBeNull()
  })
})

describe('persistLegacyStoreWriterGate', () => {
  it('clears the durable fence when drain rolls back to open', async () => {
    const profilePath = profile()
    const gate = persistLegacyStoreWriterGate(profilePath, createLegacyStoreWriterGate())
    expect(gate.beginDrain()).toBe(true)
    expect(readDesktopWriterFence(profilePath)?.state).toBe('draining')
    expect(gate.rollbackDrain()).toBe(true)
    expect(gate.snapshot().state).toBe('open')
    expect(readDesktopWriterFence(profilePath)).toBeNull()
  })
})
