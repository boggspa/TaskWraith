import { describe, expect, it } from 'vitest'
import type { ExternalPathGrant } from '../../../main/store/types'
import { buildExternalPathOriginTooltip } from './ExternalPathAboveRow'

// 1.0.5-EW42b — Pure-helper coverage for the banner origin
// tooltip. Verifies each grant-id prefix maps to the correct
// origin phrase, the provider name is human-readable, and the
// ISO `createdAt` is formatted via `Date.toLocaleString` (the
// exact format is locale-specific so we only check that the year
// digits appear somewhere — that's enough to confirm the path
// took the parse-then-format branch, not the raw-string
// fallback).
function makeGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'runtime-1700000000000-abcd',
    provider: 'codex',
    chatId: 'chat-1',
    path: '/repo/sibling',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: '2026-05-27T22:00:00.000Z',
    ...overrides
  }
}

describe('buildExternalPathOriginTooltip', () => {
  it('returns the proactive phrase for proactive-prefixed ids (EW42a-issued)', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({ id: 'proactive-1700000000000-codex-abcd' })
    )
    expect(tooltip).toMatch(/You granted this via the composer workspace switcher\./)
    // Provider name + secondary-workspace scope still appear in the header line.
    expect(tooltip).toMatch(/Codex/)
    expect(tooltip).toMatch(/secondary workspace/)
  })

  it('returns the runtime/approval phrase for runtime-prefixed ids', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({ id: 'runtime-1700000000000-abcd', provider: 'claude' })
    )
    expect(tooltip).toMatch(/Claude requested access during a tool call/)
    expect(tooltip).toMatch(/you approved it/)
  })

  it('returns a manual-picker phrase for legacy ids (numeric prefix, no known marker)', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ id: '1700000000000-abcd' }))
    expect(tooltip).toMatch(/Granted manually via an older picker\./)
  })

  it('uses the provider label, secondary scope, and a parsed timestamp in the header line', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({
        id: 'proactive-x',
        provider: 'gemini',
        access: 'write',
        createdAt: '2026-05-27T22:00:00.000Z'
      })
    )
    // First line: "<Provider> · secondary workspace · <when>".
    const [header] = tooltip.split('\n')
    expect(header).toMatch(/Gemini/)
    expect(header).toMatch(/secondary workspace/)
    // Some locale-formatted date appears — at minimum the year
    // shows up after toLocaleString parses the ISO timestamp.
    expect(header).toMatch(/2026/)
  })

  it('falls back to the raw createdAt string when parsing yields NaN', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ createdAt: 'not-a-date' }))
    const [header] = tooltip.split('\n')
    expect(header).toMatch(/not-a-date/)
  })

  it('does not surface read/write access wording in the header line', () => {
    const tooltip = buildExternalPathOriginTooltip(makeGrant({ access: 'write' }))
    expect(tooltip.split('\n')[0]).toMatch(/secondary workspace/)
    expect(tooltip.split('\n')[0]).not.toMatch(/edit access/)
    expect(tooltip.split('\n')[0]).not.toMatch(/read access/)
  })

  it('runtime-prefixed write grants combine the verb + provider name correctly', () => {
    const tooltip = buildExternalPathOriginTooltip(
      makeGrant({
        id: 'runtime-1700000000000-abcd',
        provider: 'kimi',
        access: 'write'
      })
    )
    expect(tooltip).toMatch(/Kimi requested access during a tool call/)
    expect(tooltip.split('\n')[0]).toMatch(/secondary workspace/)
  })
})
