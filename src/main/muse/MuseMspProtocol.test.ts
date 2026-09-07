import { describe, expect, it } from 'vitest'
import {
  decodeMuseMspFrames,
  encodeMuseMspFrame,
  museMspCommandId,
  MUSE_MSP_CLIENT_NAME,
  MUSE_MSP_CLIENT_NAME_PATTERN,
  MUSE_MSP_COMPACTION_OUTCOMES,
  MUSE_MSP_COMPACTION_TRIGGERS,
  MUSE_MSP_CONTEXT_PRESSURE_LEVELS
} from './MuseMspProtocol'

function bytes(fill: number): (size: number) => Uint8Array {
  return (size) => Uint8Array.from({ length: size }, () => fill)
}

describe('decodeMuseMspFrames — NDJSON framing', () => {
  it('splits complete lines and returns the unconsumed tail', () => {
    const { frames, rest } = decodeMuseMspFrames(
      '{"jsonrpc":"2.0","method":"turn/started","params":{"a":1}}\n{"jsonrpc":"2.0","id":1,"resu'
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ kind: 'notification', method: 'turn/started', params: { a: 1 } })
    expect(rest).toBe('{"jsonrpc":"2.0","id":1,"resu')
  })

  it('reassembles a frame split across two chunks', () => {
    const first = decodeMuseMspFrames('{"jsonrpc":"2.0","id":7,"result":{"ok":')
    expect(first.frames).toHaveLength(0)
    const second = decodeMuseMspFrames(`${first.rest}true}}\n`)
    expect(second.frames).toEqual([{ kind: 'response', id: 7, result: { ok: true } }])
    expect(second.rest).toBe('')
  })

  it('skips blank lines rather than reporting them as frames', () => {
    const { frames } = decodeMuseMspFrames('\n\n{"jsonrpc":"2.0","method":"view/gap"}\n\n')
    expect(frames).toEqual([{ kind: 'notification', method: 'view/gap', params: {} }])
  })

  it('reports an unparsable line instead of throwing', () => {
    // muse writes its workspace banner to stderr, but a lane that ever merges
    // the streams must degrade rather than kill the turn.
    const { frames } = decodeMuseMspFrames('muse: workspace root: /tmp\n')
    expect(frames).toEqual([{ kind: 'unparsable', line: 'muse: workspace root: /tmp' }])
  })

  it('classifies an error response as a response, not a notification', () => {
    const { frames } = decodeMuseMspFrames(
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"bad","data":{"kind":"invalidParams"}}}\n'
    )
    expect(frames[0]).toMatchObject({ kind: 'response', id: 2 })
    expect((frames[0] as { error?: { data?: { kind?: string } } }).error?.data?.kind).toBe(
      'invalidParams'
    )
  })

  it('classifies an id+method frame as an inbound REQUEST needing a reply', () => {
    // A notification is fire-and-forget; a request left unanswered wedges the
    // host. The discriminator is the presence of BOTH id and method.
    const { frames } = decodeMuseMspFrames(
      '{"jsonrpc":"2.0","id":"a","method":"approval/request","params":{"approvalId":"x"}}\n'
    )
    expect(frames[0]).toEqual({
      kind: 'request',
      id: 'a',
      method: 'approval/request',
      params: { approvalId: 'x' }
    })
  })

  it('tolerates a non-object params member', () => {
    const { frames } = decodeMuseMspFrames('{"jsonrpc":"2.0","method":"x","params":[1,2]}\n')
    expect(frames[0]).toEqual({ kind: 'notification', method: 'x', params: {} })
  })

  it('treats a bare JSON array or scalar as unparsable', () => {
    expect(decodeMuseMspFrames('[1,2]\n').frames[0]).toMatchObject({ kind: 'unparsable' })
    expect(decodeMuseMspFrames('42\n').frames[0]).toMatchObject({ kind: 'unparsable' })
  })
})

describe('encodeMuseMspFrame', () => {
  it('terminates every frame with the newline the transport requires', () => {
    const line = encodeMuseMspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(line.endsWith('\n')).toBe(true)
    expect(decodeMuseMspFrames(line).frames).toHaveLength(1)
  })
})

describe('museMspCommandId — required UUIDv7 on every command', () => {
  it('emits a canonical v7 uuid with the version and variant nibbles set', () => {
    const id = museMspCommandId(bytes(0x00), 0)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the millisecond timestamp across ALL SIX leading bytes', () => {
    // Fill with a NON-ZERO byte so a dropped timestamp byte is visible, and
    // assert the full 12-hex prefix: an earlier version checked only
    // `slice(0, 8)`, which reaches bytes 0-3 and stayed green when bytes 4 and
    // 5 were deleted.
    const at = (ms: number): string => museMspCommandId(bytes(0xab), ms).replace(/-/g, '')
    expect(at(1_000_000).slice(0, 12)).toBe((1_000_000).toString(16).padStart(12, '0'))
    expect(at(2_000_000).slice(0, 12)).toBe((2_000_000).toString(16).padStart(12, '0'))
  })

  it('orders two ids minted ONE MILLISECOND apart', () => {
    // The low timestamp bytes only carry sub-second precision, so a fixture a
    // thousand seconds apart cannot see them go missing.
    const at = (ms: number): string => museMspCommandId(bytes(0xab), ms).replace(/-/g, '')
    expect(at(1_700_000_000_000) < at(1_700_000_000_001)).toBe(true)
  })

  it('keeps the version nibble even when the random source is all ones', () => {
    const id = museMspCommandId(bytes(0xff), 0)
    expect(id[14]).toBe('7')
    expect('89ab').toContain(id[19])
  })
})

describe('MUSE_MSP_CLIENT_NAME', () => {
  it('is a machine identifier the host will accept', () => {
    // `taskwraith-spike` is rejected -32602 invalidParams; the hyphen is the
    // whole reason this constant exists.
    expect(MUSE_MSP_CLIENT_NAME).toMatch(MUSE_MSP_CLIENT_NAME_PATTERN)
    expect(MUSE_MSP_CLIENT_NAME_PATTERN.test('taskwraith-spike')).toBe(false)
  })
})

describe('Muse MSP context pressure vs compaction vocabulary', () => {
  it('keeps occupancy pressure and the compaction item on separate planes', () => {
    expect(MUSE_MSP_CONTEXT_PRESSURE_LEVELS).toEqual(['normal', 'warning', 'blocked'])
    expect(MUSE_MSP_CONTEXT_PRESSURE_LEVELS).not.toContain('compacting')
    expect(MUSE_MSP_COMPACTION_TRIGGERS).toEqual(['manual', 'auto'])
    expect(MUSE_MSP_COMPACTION_OUTCOMES).toEqual(['compacted', 'noop', 'failed', 'cancelled'])
  })
})
