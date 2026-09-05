import { describe, expect, it } from 'vitest'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../shared/ensembleLimits'
import { ENSEMBLE_WRITER_GIT_GUIDANCE, providerLabel } from '../EnsemblePrompt'
import type { EnsembleParticipant } from '../store/types'
import {
  dedupeParticipants,
  extractJsonFromContent,
  isBroadFanoutRequest,
  isUserYieldTarget,
  normalizeTargetList,
  parseConcurrentWriteScopeAck,
  parseConcurrentWriteScopeClaim,
  pickRawWriteScopesForParticipant,
  rawClaimScopes,
  sanitizedStringList,
  stripLeadingAt,
  writeScopeAckPrompt,
  writeScopeClaimPrompt,
  writeScopeExecutionPrompt
} from './EnsembleWriteScopeClaims'

const APPROVED_AT = '2026-09-05T12:00:00.000Z'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'p1',
    provider: 'codex',
    role: 'Work4',
    enabled: true,
    order: 1,
    instructions: '',
    permissionPresetId: 'default',
    ...overrides
  } as EnsembleParticipant
}

function claimFence(body: string): string {
  return '```taskwraith_write_claim\n' + body + '\n```'
}

function ackFence(body: string): string {
  return '```taskwraith_write_ack\n' + body + '\n```'
}

describe('stripLeadingAt', () => {
  it('trims and strips one or more leading @ marks', () => {
    expect(stripLeadingAt('  @Work4  ')).toBe('Work4')
    expect(stripLeadingAt('@@@Advisor')).toBe('Advisor')
    expect(stripLeadingAt('Work4')).toBe('Work4')
    expect(stripLeadingAt(' @ ')).toBe('')
  })
})

describe('isUserYieldTarget', () => {
  it('accepts user/human/you with optional @ and mixed case', () => {
    expect(isUserYieldTarget('user')).toBe(true)
    expect(isUserYieldTarget('@Human')).toBe(true)
    expect(isUserYieldTarget(' YOU ')).toBe(true)
    expect(isUserYieldTarget(undefined)).toBe(false)
    expect(isUserYieldTarget('')).toBe(false)
    expect(isUserYieldTarget('Advisor')).toBe(false)
    expect(isUserYieldTarget('@users')).toBe(false)
  })
})

describe('normalizeTargetList', () => {
  it('normalizes arrays, a single string, and empty/invalid values', () => {
    expect(normalizeTargetList([' @A ', '', 1, 'B'])).toEqual(['@A', 'B'])
    expect(normalizeTargetList('  Work4  ')).toEqual(['Work4'])
    expect(normalizeTargetList('')).toEqual([])
    expect(normalizeTargetList(undefined)).toEqual([])
    expect(normalizeTargetList(null)).toEqual([])
  })

  it(`caps array targets at MAX_ENSEMBLE_PARTICIPANTS (${MAX_ENSEMBLE_PARTICIPANTS})`, () => {
    const values = Array.from({ length: MAX_ENSEMBLE_PARTICIPANTS + 5 }, (_, i) => `p${i}`)
    expect(normalizeTargetList(values)).toHaveLength(MAX_ENSEMBLE_PARTICIPANTS)
    expect(normalizeTargetList(values)[0]).toBe('p0')
  })
})

describe('isBroadFanoutRequest', () => {
  it('treats empty lists and @all/all as broad, and named targets as not', () => {
    expect(isBroadFanoutRequest(undefined)).toBe(true)
    expect(isBroadFanoutRequest([])).toBe(true)
    expect(isBroadFanoutRequest('all')).toBe(true)
    expect(isBroadFanoutRequest('@ALL')).toBe(true)
    expect(isBroadFanoutRequest(['Work4', '@all'])).toBe(true)
    expect(isBroadFanoutRequest(['Work4', 'Work5'])).toBe(false)
    expect(isBroadFanoutRequest('Work4')).toBe(false)
  })
})

describe('dedupeParticipants', () => {
  it('keeps first occurrence by id and skips missing ids', () => {
    const a = participant({ id: 'p1', role: 'A' })
    const b = participant({ id: 'p2', role: 'B' })
    const aDup = participant({ id: 'p1', role: 'A-dup' })
    const missing = { ...participant({ role: 'Ghost' }), id: '' }
    expect(dedupeParticipants([a, missing, b, aDup])).toEqual([a, b])
  })
})

describe('pickRawWriteScopesForParticipant', () => {
  it('passes through arrays and strings unchanged', () => {
    expect(pickRawWriteScopesForParticipant(['src/a.ts'], participant())).toEqual(['src/a.ts'])
    expect(pickRawWriteScopesForParticipant('src/a.ts', participant())).toBe('src/a.ts')
  })

  it('resolves map keys by id, role, provider, label, *, and all', () => {
    const p = participant({ id: 'ensemble-participant-14', role: 'Work4', provider: 'grok' })
    expect(pickRawWriteScopesForParticipant({ 'ensemble-participant-14': ['id-hit'] }, p)).toEqual([
      'id-hit'
    ])
    expect(pickRawWriteScopesForParticipant({ '@Work4': ['role-hit'] }, p)).toEqual(['role-hit'])
    expect(pickRawWriteScopesForParticipant({ grok: ['provider-hit'] }, p)).toEqual([
      'provider-hit'
    ])
    expect(pickRawWriteScopesForParticipant({ [providerLabel('grok')]: ['label-hit'] }, p)).toEqual(
      ['label-hit']
    )
    expect(pickRawWriteScopesForParticipant({ '*': ['star-hit'] }, p)).toEqual(['star-hit'])
    expect(pickRawWriteScopesForParticipant({ ALL: ['all-hit'] }, p)).toEqual(['all-hit'])
    expect(pickRawWriteScopesForParticipant({ other: ['nope'] }, p)).toBeUndefined()
    expect(pickRawWriteScopesForParticipant(1, p)).toBeUndefined()
  })
})

describe('extractJsonFromContent', () => {
  it('parses a matching fenced block and skips a mismatched language fence', () => {
    const content = [
      '```ts',
      '{ "ignored": true }',
      '```',
      '```taskwraith_write_claim',
      '{ "writeScopes": ["src/a.ts"] }',
      '```'
    ].join('\n')
    expect(extractJsonFromContent(content, 'taskwraith_write_claim')).toEqual({
      writeScopes: ['src/a.ts']
    })
  })

  it('accepts a json fence and falls back to the outermost braces', () => {
    expect(extractJsonFromContent('```json\n{"ok":true}\n```', 'taskwraith_write_ack')).toEqual({
      ok: true
    })
    expect(extractJsonFromContent('prefix {"ack":true} suffix', 'taskwraith_write_ack')).toEqual({
      ack: true
    })
  })

  it('returns null for invalid JSON or missing objects', () => {
    expect(extractJsonFromContent('```json\n{nope}\n```', 'json')).toBeNull()
    expect(extractJsonFromContent('no object here', 'taskwraith_write_claim')).toBeNull()
    expect(extractJsonFromContent('} backwards {', 'taskwraith_write_claim')).toBeNull()
  })
})

describe('sanitizedStringList', () => {
  it('filters, trims, caps count, and caps length', () => {
    expect(sanitizedStringList('nope')).toEqual([])
    expect(sanitizedStringList(['  edit  ', '', 1, 'create'])).toEqual(['edit', 'create'])
    expect(sanitizedStringList(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
    expect(sanitizedStringList(['abcdefghij'], 12, 4)).toEqual(['abcd'])
  })
})

describe('rawClaimScopes', () => {
  it('prefers writeScopes then snake/alias keys', () => {
    expect(rawClaimScopes({ writeScopes: ['a'], write_scopes: ['b'] })).toEqual(['a'])
    expect(rawClaimScopes({ write_scopes: ['b'] })).toEqual(['b'])
    expect(rawClaimScopes({ scopes: ['c'] })).toEqual(['c'])
    expect(rawClaimScopes({ paths: ['d'] })).toEqual(['d'])
    expect(rawClaimScopes({ globs: ['e'] })).toEqual(['e'])
    expect(rawClaimScopes({})).toBeUndefined()
  })
})

describe('parseConcurrentWriteScopeClaim', () => {
  const runBase = {
    participant: participant()
  }

  it('parses a valid fenced claim including operations and rationale', () => {
    const parsed = parseConcurrentWriteScopeClaim(
      {
        ...runBase,
        content: claimFence(
          JSON.stringify({
            writeScopes: ['src/main/services/EnsembleWriteScopeClaims.ts'],
            operations: ['edit', 'create'],
            rationale: 'Own the claim helpers',
            canFallbackToSerial: true,
            acknowledgeExclusiveScope: true
          })
        )
      },
      APPROVED_AT
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.claim.participantId).toBe('p1')
    expect(parsed.claim.participantRole).toBe('Work4')
    expect(parsed.claim.provider).toBe('codex')
    expect(parsed.claim.canFallbackToSerial).toBe(true)
    expect(parsed.claim.operations).toEqual(['edit', 'create'])
    expect(parsed.claim.rationale).toBe('Own the claim helpers')
    expect(parsed.claim.scopes).toEqual([
      {
        kind: 'path',
        path: 'src/main/services/EnsembleWriteScopeClaims.ts',
        approvedBy: 'user-preflight',
        approvedAt: APPROVED_AT
      }
    ])
  })

  it('accepts snake_case ack/fallback aliases and operation_types', () => {
    const parsed = parseConcurrentWriteScopeClaim(
      {
        ...runBase,
        content: claimFence(
          JSON.stringify({
            write_scopes: ['src/a.ts'],
            operation_types: ['rename'],
            can_fallback_to_serial: true,
            acknowledge_scope_matrix: true
          })
        )
      },
      APPROVED_AT
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.claim.operations).toEqual(['rename'])
  })

  it('rejects missing JSON, empty scopes, vague workspace, and missing ack/fallback', () => {
    expect(parseConcurrentWriteScopeClaim({ ...runBase, content: 'no json' }, APPROVED_AT)).toEqual(
      {
        ok: false,
        reason: 'Work4 did not return a valid taskwraith_write_claim JSON object.'
      }
    )
    expect(
      parseConcurrentWriteScopeClaim(
        {
          ...runBase,
          content: claimFence(
            JSON.stringify({
              writeScopes: [],
              canFallbackToSerial: true,
              acknowledgeExclusiveScope: true
            })
          )
        },
        APPROVED_AT
      )
    ).toEqual({
      ok: false,
      reason: 'Work4 did not claim any concrete write scopes.'
    })
    expect(
      parseConcurrentWriteScopeClaim(
        {
          ...runBase,
          content: claimFence(
            JSON.stringify({
              writeScopes: ['workspace'],
              canFallbackToSerial: true,
              acknowledgeExclusiveScope: true
            })
          )
        },
        APPROVED_AT
      )
    ).toEqual({
      ok: false,
      reason: 'Work4 claimed a vague or workspace-wide write scope.'
    })
    expect(
      parseConcurrentWriteScopeClaim(
        {
          ...runBase,
          content: claimFence(
            JSON.stringify({
              writeScopes: ['src/a.ts'],
              canFallbackToSerial: true
            })
          )
        },
        APPROVED_AT
      )
    ).toEqual({
      ok: false,
      reason: 'Work4 did not acknowledge the exclusive write-scope contract.'
    })
    expect(
      parseConcurrentWriteScopeClaim(
        {
          ...runBase,
          content: claimFence(
            JSON.stringify({
              writeScopes: ['src/a.ts'],
              acknowledgeExclusiveScope: true
            })
          )
        },
        APPROVED_AT
      )
    ).toEqual({
      ok: false,
      reason: 'Work4 did not confirm it can fall back to serial execution.'
    })
  })

  it('uses providerLabel when role is missing and caps rationale at 500', () => {
    const unlabeled = participant({ role: undefined, provider: 'codex' })
    delete (unlabeled as { role?: string }).role
    const parsed = parseConcurrentWriteScopeClaim(
      {
        participant: unlabeled,
        content: claimFence(
          JSON.stringify({
            writeScopes: ['src/a.ts'],
            canFallbackToSerial: true,
            acknowledgeExclusiveScope: true,
            rationale: 'x'.repeat(600)
          })
        )
      },
      APPROVED_AT
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.claim.participantRole).toBe(providerLabel('codex'))
    expect(parsed.claim.rationale).toHaveLength(500)
  })
})

describe('parseConcurrentWriteScopeAck', () => {
  const runBase = { participant: participant() }

  it('accepts the four true ack keys and rejects everything else', () => {
    expect(
      parseConcurrentWriteScopeAck({
        ...runBase,
        content: ackFence('{ "acknowledgeMatrix": true }')
      })
    ).toBe(true)
    expect(
      parseConcurrentWriteScopeAck({
        ...runBase,
        content: ackFence('{ "acknowledge_matrix": true }')
      })
    ).toBe(true)
    expect(
      parseConcurrentWriteScopeAck({
        ...runBase,
        content: ackFence('{ "acknowledgeScopeMatrix": true }')
      })
    ).toBe(true)
    expect(
      parseConcurrentWriteScopeAck({
        ...runBase,
        content: ackFence('{ "ack": true }')
      })
    ).toBe(true)
    expect(
      parseConcurrentWriteScopeAck({
        ...runBase,
        content: ackFence('{ "ack": false }')
      })
    ).toBe(false)
    expect(parseConcurrentWriteScopeAck({ ...runBase, content: 'no json' })).toBe(false)
  })
})

describe('write-scope prompts', () => {
  it('keeps claim schema, ack matrix, and execution git guidance', () => {
    const claim = writeScopeClaimPrompt()
    expect(claim).toContain('taskwraith_write_claim')
    expect(claim).toContain('"writeScopes"')
    expect(claim).toContain('"acknowledgeExclusiveScope": true')
    expect(claim).toContain('canFallbackToSerial')

    const ack = writeScopeAckPrompt('Work4 -> src/a.ts')
    expect(ack).toContain('taskwraith_write_ack')
    expect(ack).toContain('Work4 -> src/a.ts')
    expect(ack).toContain('acknowledgeMatrix')

    const execution = writeScopeExecutionPrompt('Work4 -> src/a.ts')
    expect(execution).toContain('Locked writer fan-out is authorized by user preflight.')
    expect(execution).toContain(ENSEMBLE_WRITER_GIT_GUIDANCE)
    expect(execution).toContain('Work4 -> src/a.ts')
  })
})
