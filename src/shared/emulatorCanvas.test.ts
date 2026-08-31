import { describe, expect, it } from 'vitest'
import {
  EMULATOR_MAX_STATE_FIELDS,
  EMULATOR_STEP_MAX_SEGMENTS,
  canonicalEmulatorStateAdapterSchemaJson,
  decodeEmulatorMappedState,
  validateEmulatorFrameMetadata,
  validateEmulatorMappedState,
  validateEmulatorObservation,
  validateEmulatorObservationToken,
  validateEmulatorPackageManifest,
  validateEmulatorStateAdapterManifest,
  validateEmulatorStepRequest,
  validateEmulatorStepToolInput
} from './emulatorCanvas'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const TIMESTAMP = '2026-08-31T16:00:00.000Z'

function adapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    adapterId: 'homebrew-gb-state',
    adapterRevision: 'v1',
    schemaSha256: HASH_A,
    coreId: 'sameboy-wasm',
    romSha256: HASH_B,
    memoryBytes: 32,
    fields: [
      { key: 'health', kind: 'integer', read: { address: 0, encoding: 'u8' }, unit: 'hearts' },
      { key: 'has-key', kind: 'boolean', read: { address: 1, encoding: 'bit', bit: 2 } },
      {
        key: 'area',
        kind: 'enum',
        read: { address: 2, encoding: 'u8' },
        enumValues: { '0': 'start', '1': 'cave' }
      }
    ],
    ...overrides
  }
}

function packageManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    gameId: 'tw-homebrew-gb',
    coreId: 'sameboy-wasm',
    coreSha256: HASH_C,
    romSha256: HASH_B,
    stateAdapter: adapter(),
    ...overrides
  }
}

function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationId: 'eobs:canvas-1:7',
    emulationGeneration: 2,
    frameId: 42,
    inputEpoch: 3,
    ...overrides
  }
}

describe('emulator package and state adapter manifests', () => {
  it('accepts a package-owned adapter only when its core and ROM binding match', () => {
    const result = validateEmulatorPackageManifest(packageManifest())

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        gameId: 'tw-homebrew-gb',
        coreId: 'sameboy-wasm',
        romSha256: HASH_B,
        stateAdapter: expect.objectContaining({ adapterId: 'homebrew-gb-state' })
      })
    })
  })

  it('rejects non-canonical IDs, bad hashes, and an adapter bound to another package', () => {
    expect(
      validateEmulatorPackageManifest(packageManifest({ gameId: 'not canonical' }))
    ).toMatchObject({
      ok: false
    })
    expect(validateEmulatorPackageManifest(packageManifest({ coreSha256: 'ABC' }))).toMatchObject({
      ok: false
    })
    expect(
      validateEmulatorPackageManifest(
        packageManifest({ stateAdapter: adapter({ coreId: 'other-core' }) })
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/match/i) })
  })

  it('allows an explicit no-map package without inventing RAM addresses', () => {
    expect(validateEmulatorPackageManifest(packageManifest({ stateAdapter: null }))).toEqual({
      ok: true,
      value: expect.objectContaining({ stateAdapter: null })
    })
    expect(
      validateEmulatorPackageManifest(packageManifest({ stateAdapter: undefined }))
    ).toMatchObject({
      ok: false
    })
  })

  it('defines schemaSha256 over canonical adapter JSON that omits the hash itself', () => {
    const parsed = validateEmulatorStateAdapterManifest(adapter())
    if (!parsed.ok) throw new Error(parsed.reason)

    const canonical = canonicalEmulatorStateAdapterSchemaJson(parsed.value)
    expect(canonical).not.toContain('schemaSha256')
    const body = JSON.parse(canonical) as { adapterId: string; fields: Array<{ key: string }> }
    expect(body.adapterId).toBe('homebrew-gb-state')
    expect(body.fields[0]).toMatchObject({ key: 'health' })
  })

  it('bounds adapter fields, reads, and enum declarations', () => {
    expect(
      validateEmulatorStateAdapterManifest(
        adapter({
          fields: Array.from({ length: EMULATOR_MAX_STATE_FIELDS + 1 }, (_, index) => ({
            key: `f-${index}`,
            kind: 'integer',
            read: { address: 0, encoding: 'u8' }
          }))
        })
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/fields/i) })

    expect(
      validateEmulatorStateAdapterManifest(
        adapter({
          fields: [{ key: 'bad-read', kind: 'integer', read: { address: 32, encoding: 'u8' } }]
        })
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/address/i) })

    expect(
      validateEmulatorStateAdapterManifest(
        adapter({
          fields: [
            {
              key: 'bad-enum',
              kind: 'enum',
              read: { address: 0, encoding: 'u8' },
              enumValues: { nope: 'bad' }
            }
          ]
        })
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/canonical safe integer/i) })

    expect(
      validateEmulatorStateAdapterManifest(
        adapter({
          fields: [
            { key: 'bad-boolean', kind: 'boolean', read: { address: 0, encoding: 'u8', scale: 2 } }
          ]
        })
      )
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/must not transform/i) })
  })

  it('decodes only declared bounded reads and never returns raw memory', () => {
    const parsed = validateEmulatorStateAdapterManifest(
      adapter({
        fields: [
          {
            key: 'health',
            kind: 'integer',
            read: { address: 0, encoding: 'i8', scale: 0.5, offset: 1 },
            unit: 'hearts'
          },
          { key: 'has-key', kind: 'boolean', read: { address: 1, encoding: 'bit', bit: 2 } },
          {
            key: 'area',
            kind: 'enum',
            read: { address: 2, encoding: 'u8' },
            enumValues: { '0': 'start', '1': 'cave' }
          }
        ]
      })
    )
    if (!parsed.ok) throw new Error(parsed.reason)

    const memory = new Uint8Array(32)
    memory[0] = 254 // i8 -2 -> scaled to 0
    memory[1] = 4
    memory[2] = 9 // undeclared enum value
    const decoded = decodeEmulatorMappedState(parsed.value, memory)

    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: 'mapped',
        adapterId: 'homebrew-gb-state',
        adapterRevision: 'v1',
        schemaSha256: HASH_A,
        truncated: false,
        fields: [
          { key: 'health', kind: 'integer', value: 0, unit: 'hearts' },
          { key: 'has-key', kind: 'boolean', value: true },
          { key: 'area', kind: 'enum', value: 'unknown' }
        ]
      }
    })
    expect(decodeEmulatorMappedState(parsed.value, new Uint8Array(4))).toMatchObject({ ok: false })
    expect(decodeEmulatorMappedState(parsed.value, new Uint8Array(33))).toMatchObject({ ok: false })
  })
})

describe('emulator observations', () => {
  it('validates opaque tokens, bounded PNG metadata, and the combined projection', () => {
    const validToken = validateEmulatorObservationToken(token())
    expect(validToken).toMatchObject({ ok: true })
    expect(validateEmulatorObservationToken(token({ frameId: -1 }))).toMatchObject({ ok: false })

    const frame = {
      mimeType: 'image/png',
      width: 256,
      height: 240,
      byteLength: 4096,
      hash: HASH_C,
      capturedAt: TIMESTAMP
    }
    expect(validateEmulatorFrameMetadata(frame)).toMatchObject({ ok: true })
    expect(validateEmulatorFrameMetadata({ ...frame, mimeType: 'image/jpeg' })).toMatchObject({
      ok: false
    })

    const state = {
      kind: 'mapped',
      adapterId: 'homebrew-gb-state',
      adapterRevision: 'v1',
      schemaSha256: HASH_A,
      fields: [{ key: 'health', kind: 'integer', value: 3, unit: 'hearts' }],
      truncated: false
    }
    expect(validateEmulatorMappedState(state)).toMatchObject({ ok: true })
    expect(
      validateEmulatorObservation({
        schemaVersion: 1,
        token: token(),
        capturedAt: TIMESTAMP,
        frame,
        state
      })
    ).toMatchObject({ ok: true })
    expect(
      validateEmulatorObservation({
        schemaVersion: 1,
        token: token(),
        capturedAt: TIMESTAMP,
        frame,
        state: { kind: 'unavailable', reason: 'no_verified_adapter' }
      })
    ).toMatchObject({ ok: true })
  })
})

describe('emulator_step request bounds', () => {
  it('accepts a bounded macro, including an intentional no-button wait segment', () => {
    const request = validateEmulatorStepRequest({
      expected: token(),
      segments: [
        { buttons: ['right', 'a'], frames: 30 },
        { buttons: [], frames: 10 }
      ],
      requireIndependentVerifier: true
    })

    expect(request).toEqual({
      ok: true,
      value: {
        expected: token(),
        segments: [
          { buttons: ['right', 'a'], frames: 30 },
          { buttons: [], frames: 10 }
        ],
        requireIndependentVerifier: true
      }
    })
  })

  it('rejects too many segments, overlong macros, duplicate buttons, and opposite directions', () => {
    expect(
      validateEmulatorStepRequest({
        expected: token(),
        segments: Array.from({ length: EMULATOR_STEP_MAX_SEGMENTS + 1 }, () => ({
          buttons: [],
          frames: 1
        }))
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/segments/i) })

    expect(
      validateEmulatorStepRequest({
        expected: token(),
        segments: [
          { buttons: [], frames: 120 },
          { buttons: [], frames: 120 },
          { buttons: [], frames: 1 }
        ]
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/240/i) })

    expect(
      validateEmulatorStepRequest({
        expected: token(),
        segments: [{ buttons: ['a', 'a'], frames: 1 }]
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/duplicate/i) })

    expect(
      validateEmulatorStepRequest({
        expected: token(),
        segments: [{ buttons: ['up', 'down'], frames: 1 }]
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/opposite/i) })
  })

  it('keeps public tool input to an opaque observation id', () => {
    expect(
      validateEmulatorStepToolInput({
        expectedObservationId: 'eobs:canvas-1:7',
        segments: [{ buttons: ['a'], frames: 1 }]
      })
    ).toEqual({
      ok: true,
      value: {
        expectedObservationId: 'eobs:canvas-1:7',
        segments: [{ buttons: ['a'], frames: 1 }]
      }
    })
  })
})
