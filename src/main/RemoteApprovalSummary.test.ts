import { describe, expect, it } from 'vitest'
import { REMOTE_APPROVAL_BODY_BUDGET, buildRemoteApprovalSummary } from './RemoteApprovalSummary'

const draft = (to: string[], cc: string[] = [], subject = 'Weekly update') => ({
  kind: 'tool',
  toolName: 'outlook_create_draft',
  params: { to, cc, subject, body: 'B' }
})

describe('buildRemoteApprovalSummary', () => {
  it('leads with the recipients and never carries the agent intent', () => {
    const summary = buildRemoteApprovalSummary({
      ...draft(['bob@example.com'], ['exfil@attacker.example']),
      intent: 'x'.repeat(600)
    })
    expect(summary.complete).toBe(true)
    expect(summary.text?.startsWith('To: bob@example.com')).toBe(true)
    expect(summary.text).toContain('Cc: exfil@attacker.example')
    // A 600-char intent used to consume the whole 400-char remote budget.
    expect(summary.text).not.toContain('xxx')
    expect(summary.text!.length).toBeLessThanOrEqual(REMOTE_APPROVAL_BODY_BUDGET)
  })

  it('keeps the cc visible at recipient counts that used to truncate it', () => {
    // Ten ordinary addresses pushed the cc off the card on their own.
    const to = Array.from({ length: 10 }, (_, i) => `person.number.${i}@partner-company.example`)
    const summary = buildRemoteApprovalSummary(draft(to, ['exfil@attacker.example']))
    expect(summary.complete).toBe(false)
    // …and because it cannot be shown in full, accept is withheld upstream.
  })

  it('refuses completeness when the fields do not fit', () => {
    const to = Array.from({ length: 50 }, (_, i) => `${'a'.repeat(300)}${i}@example.com`)
    const summary = buildRemoteApprovalSummary(draft(to))
    expect(summary.complete).toBe(false)
    expect(summary.text!.length).toBeLessThanOrEqual(REMOTE_APPROVAL_BODY_BUDGET)
  })

  it('states an empty recipient list rather than omitting it', () => {
    const summary = buildRemoteApprovalSummary(draft([]))
    expect(summary.text).toContain('To: (none)')
    expect(summary.complete).toBe(true)
  })

  it('summarises a calendar entry and says no invitations are sent', () => {
    const summary = buildRemoteApprovalSummary({
      kind: 'tool',
      toolName: 'outlook_create_event',
      params: { subject: 'Focus block', window: '09:00 → 10:00', location: 'Room 4' }
    })
    expect(summary.text).toContain('Focus block')
    expect(summary.text).toContain('Room 4')
    expect(summary.text).toContain('no invitations are sent')
  })

  it('renders shell commands for remote review and fails closed when they do not fit', () => {
    expect(buildRemoteApprovalSummary({ kind: 'command', command: 'git status' })).toEqual({
      text: 'git status',
      complete: true
    })
    const longCommand = 'git log --oneline ' + 'a'.repeat(REMOTE_APPROVAL_BODY_BUDGET)
    const summary = buildRemoteApprovalSummary({ kind: 'command', command: longCommand })
    expect(summary.complete).toBe(false)
    expect(summary.text!.length).toBeLessThanOrEqual(REMOTE_APPROVAL_BODY_BUDGET)
    expect(buildRemoteApprovalSummary({ kind: 'command', command: '' })).toEqual({
      complete: false
    })
  })

  it('leaves every other tool to the caller body', () => {
    for (const preview of [
      { kind: 'tool', toolName: 'write_file', params: { path: 'a.ts' } },
      null,
      'not-an-object'
    ]) {
      expect(buildRemoteApprovalSummary(preview)).toEqual({ complete: true })
    }
  })
})
