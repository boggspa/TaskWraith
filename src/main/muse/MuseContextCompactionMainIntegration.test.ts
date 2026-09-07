import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

describe('museIpcBridgeDeps composition-root compaction wiring', () => {
  it('wires museIpcBridgeDeps.onContextCompaction onto the chat-card sinks', () => {
    const deps = between(
      'const museIpcBridgeDeps: MuseIpcBridgeDeps = {',
      'async function getMuseProviderStatus()'
    )
    expect(deps).toContain('onContextCompaction:')
    expect(deps).toContain('deliverMuseContextCompactionCard')
    expect(deps).toContain('appendContextCompactionMessageToChat')
    expect(deps).toContain('broadcastContextCompactionSignalProgress')
    const withoutSignalProgress = deps.replaceAll('broadcastContextCompactionSignalProgress', '')
    expect(withoutSignalProgress).not.toMatch(/broadcastContextCompactionProgress/)
  })
})
