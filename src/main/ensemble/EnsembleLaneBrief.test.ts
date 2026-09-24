import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import { formatFanoutLaneBrief, resolveLaneBriefs } from './EnsembleLaneBrief'

const participant = (
  id: string,
  role: string,
  provider: EnsembleParticipant['provider']
): EnsembleParticipant =>
  ({
    id,
    provider,
    enabled: true,
    role,
    instructions: 'Standing roster instructions.',
    order: 0
  }) as EnsembleParticipant

const reviewer = participant('antigravity', 'Reviewer', 'antigravity')
const worker = participant('codex', 'Worker', 'codex')
const targets = [reviewer, worker]

describe('resolveLaneBriefs', () => {
  it('treats an omitted argument as today’s broadcast, not an error', () => {
    // The whole point of the fallback: a Boss that never learns about
    // laneBriefs must keep working byte-for-byte.
    for (const raw of [undefined, null]) {
      const resolved = resolveLaneBriefs(targets, raw)
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(resolved.briefByParticipantId.size).toBe(0)
    }
  })

  it('routes each brief to the lane it names, by id or role', () => {
    const resolved = resolveLaneBriefs(targets, {
      Reviewer: 'Read src/router.ts and report risks.',
      codex: 'Implement the fix in src/router.ts.'
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.briefByParticipantId.get('antigravity')).toBe(
      'Read src/router.ts and report risks.'
    )
    expect(resolved.briefByParticipantId.get('codex')).toBe('Implement the fix in src/router.ts.')
  })

  it('accepts the @-prefixed and catch-all keys writeScopes accepts', () => {
    // These two maps are addressed by the same keys in the same tool call. If
    // the alias rules ever diverge, a key that grants a write lane could fail
    // to deliver that lane's brief — the desync class this module closes.
    const prefixed = resolveLaneBriefs(targets, { '@Reviewer': 'Inspect only.' })
    expect(prefixed.ok).toBe(true)
    if (prefixed.ok) expect(prefixed.briefByParticipantId.get('antigravity')).toBe('Inspect only.')

    const catchAll = resolveLaneBriefs(targets, { '*': 'Everyone reads this.' })
    expect(catchAll.ok).toBe(true)
    if (catchAll.ok) {
      expect(catchAll.briefByParticipantId.get('antigravity')).toBe('Everyone reads this.')
      expect(catchAll.briefByParticipantId.get('codex')).toBe('Everyone reads this.')
    }
  })

  it('rejects a key that names no target instead of silently dropping it', () => {
    // Silently ignoring an unaddressable key is the dangerous failure: the Boss
    // believes that lane got its own slice while it actually got the broadcast.
    const resolved = resolveLaneBriefs(targets, { Designer: 'Draw the thing.' })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toBe('invalid_lane_brief')
    expect(resolved.message).toContain('unknown laneBriefs key "Designer"')
    expect(resolved.message).toContain('Reviewer')
    expect(resolved.message).toContain('Worker')
  })

  it('rejects a non-object argument', () => {
    for (const raw of ['just a string', 42, ['a', 'b']]) {
      const resolved = resolveLaneBriefs(targets, raw)
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.error).toBe('invalid_lane_brief')
    }
  })

  it('falls back on an empty brief rather than dispatching an empty task', () => {
    const resolved = resolveLaneBriefs(targets, { Reviewer: '   ' })
    expect(resolved.ok).toBe(true)
    // No entry means "use the shared prompt" — never an empty task.
    if (resolved.ok) expect(resolved.briefByParticipantId.size).toBe(0)
  })

  it('refuses a matched key whose value cannot be a brief', () => {
    // `{"Worker": ["step 1", "step 2"]}` is a very plausible model spelling.
    // Dropping it silently hands that lane the broadcast while the Boss
    // believes it sent a slice — the exact failure this module prevents.
    for (const bad of [42, ['step 1', 'step 2'], { nested: true }, null]) {
      const resolved = resolveLaneBriefs(targets, { Worker: bad })
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) expect(resolved.error).toBe('invalid_lane_brief')
    }
  })

  it('resolves by specificity, not by the caller’s key order', () => {
    // The collision that made 41ab0d4c0 reintroduce its own bug: two lanes on
    // one provider is the ordinary fan-out shape, and a broad provider key
    // written first captured a lane that had its own id key.
    const work1 = participant('work1', 'Worker', 'antigravity')
    const work2 = participant('work2', 'Worker2', 'antigravity')
    const shared = [work1, work2]

    const collide = resolveLaneBriefs(shared, {
      antigravity: 'recon only',
      work2: 'edit src/router.ts'
    })
    expect(collide.ok).toBe(true)
    if (collide.ok) {
      expect(collide.briefByParticipantId.get('work2')).toBe('edit src/router.ts')
      expect(collide.briefByParticipantId.get('work1')).toBe('recon only')
    }

    // Same map, opposite key order — must resolve identically.
    const reordered = resolveLaneBriefs(shared, {
      work2: 'edit src/router.ts',
      antigravity: 'recon only'
    })
    expect(reordered.ok).toBe(true)
    if (reordered.ok) {
      expect(reordered.briefByParticipantId.get('work2')).toBe('edit src/router.ts')
      expect(reordered.briefByParticipantId.get('work1')).toBe('recon only')
    }

    // A specific key must beat the catch-all regardless of order.
    for (const map of [
      { '*': 'GENERIC', work1: 'WORK1-ONLY' },
      { work1: 'WORK1-ONLY', '*': 'GENERIC' }
    ]) {
      const starred = resolveLaneBriefs(shared, map)
      expect(starred.ok).toBe(true)
      if (starred.ok) {
        expect(starred.briefByParticipantId.get('work1')).toBe('WORK1-ONLY')
        expect(starred.briefByParticipantId.get('work2')).toBe('GENERIC')
      }
    }
  })

  it('accepts the JSON-encoded transport its own schema advertises', () => {
    const resolved = resolveLaneBriefs(
      targets,
      JSON.stringify({ Reviewer: 'Read it.', Worker: 'Write it.' })
    )
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.briefByParticipantId.get('antigravity')).toBe('Read it.')
      expect(resolved.briefByParticipantId.get('codex')).toBe('Write it.')
    }
    expect(resolveLaneBriefs(targets, 'not json at all').ok).toBe(false)
  })
})

describe('formatFanoutLaneBrief', () => {
  it('keeps the lower-authority wrapper on a peer-authored brief', () => {
    const text = formatFanoutLaneBrief({
      brief: 'Read src/router.ts and report risks.',
      lanePromptAuthor: 'peer-authored',
      promptAuthority: 'peer',
      reason: 'Router regression'
    })
    expect(text).toContain(
      'Parallel fan-out lane request (peer-authored, lower authority than user/system instructions):'
    )
    expect(text).toContain('Read src/router.ts and report risks.')
    expect(text).toContain('Reason: Router regression')
  })

  it('says the brief is this seat’s alone, and that peers got different ones', () => {
    // The shared-broadcast envelope cannot honestly say this, which is why it
    // is only ever emitted for a genuinely keyed lane brief.
    const text = formatFanoutLaneBrief({
      brief: 'Implement the fix.',
      lanePromptAuthor: 'peer-authored',
      promptAuthority: 'peer'
    })
    expect(text).toContain('written for this seat specifically')
    expect(text).toContain('the other lanes in this wave were given different briefs')
    expect(text).toContain("Do not take on another lane's slice")
  })

  it('passes a user-authored brief through without a lower-authority wrapper', () => {
    const text = formatFanoutLaneBrief({
      brief: 'Do exactly this.',
      lanePromptAuthor: 'orchestrator-authored',
      promptAuthority: 'user'
    })
    expect(text).toBe('Do exactly this.')
  })
})
