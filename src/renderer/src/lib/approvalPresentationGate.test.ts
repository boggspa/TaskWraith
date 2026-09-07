import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chatHasPendingApproval,
  shouldDeferTranscriptPresentation
} from './approvalPresentationGate'

const readSource = (file: string): string =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')

describe('approvalPresentationGate', () => {
  it('defers transcript presentation when a run is live or an approval is open', () => {
    expect(shouldDeferTranscriptPresentation({ running: false, approvalOpen: false })).toBe(false)
    expect(shouldDeferTranscriptPresentation({ running: true, approvalOpen: false })).toBe(true)
    expect(shouldDeferTranscriptPresentation({ running: false, approvalOpen: true })).toBe(true)
    expect(shouldDeferTranscriptPresentation({ running: true, approvalOpen: true })).toBe(true)
  })

  it('treats a head or queued approval as pending for that chat only', () => {
    expect(chatHasPendingApproval(null, { a: { id: '1' } }, { a: [{ id: '2' }] })).toBe(false)
    expect(chatHasPendingApproval('a', { a: { id: '1' } }, {})).toBe(true)
    expect(chatHasPendingApproval('a', { a: null }, { a: [{ id: '2' }] })).toBe(true)
    expect(chatHasPendingApproval('b', { a: { id: '1' } }, { a: [{ id: '2' }] })).toBe(false)
    expect(chatHasPendingApproval('a', {}, { a: [] })).toBe(false)
  })

  it('wires the gate into the focused, pane, and transcript surfaces', () => {
    const transcript = readSource('src/renderer/src/components/TranscriptPanel.tsx')
    const pane = readSource('src/renderer/src/components/ChatViewPane.tsx')
    const app = readSource('src/renderer/src/App.tsx')

    expect(transcript).toContain('shouldDeferTranscriptPresentation({')
    expect(transcript).toContain('chatHasPendingApproval(')
    expect(pane).toContain('shouldDeferTranscriptPresentation({')
    expect(pane).toContain('props.composerProps?.pendingAgentApproval')
    expect(app).toContain('shouldDeferTranscriptPresentation({')
  })
})
