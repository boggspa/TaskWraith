import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InspectorPromptTab } from './InspectorPromptTab'
import type { ChatRecord } from '../../../main/store/types'
import type { PromptEnvelopeSnapshot } from '../../../shared/instructions/InstructionTypes'

function chatWithEnvelope(envelope: PromptEnvelopeSnapshot | undefined): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'cursor',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: envelope
      ? [
          {
            runId: 'run-1',
            provider: 'cursor',
            startedAt: '2026-08-11T12:00:00Z',
            promptEnvelope: envelope
          }
        ]
      : []
  } as unknown as ChatRecord
}

const envelope: PromptEnvelopeSnapshot = {
  version: 1,
  composedAt: '2026-08-11T12:00:00Z',
  provider: 'cursor',
  model: 'cursor-default',
  accuracy: 'composed',
  layers: [
    {
      id: 'runtime_preamble',
      label: 'TaskWraith runtime preamble (taskwraith-runtime-v9)',
      state: 'applied',
      sha256: 'a'.repeat(64),
      bytes: 420
    },
    {
      id: 'instructions_global',
      label: 'User instructions — global',
      state: 'inherited',
      reason: 'already delivered to this provider session (digest match)',
      sha256: 'b'.repeat(64)
    },
    {
      id: 'instructions_workspace',
      label: 'User instructions — workspace (TASKWRAITH.md)',
      state: 'skipped',
      reason: 'symlink_refused'
    },
    { id: 'current_request', label: 'Current request', state: 'applied', bytes: 25 }
  ],
  composedSha256: 'c'.repeat(64),
  composedBytes: 2048,
  contentStored: false,
  instructionsDigest: 'digest-v1'
}

describe('InspectorPromptTab', () => {
  it('renders the layers view with states, digests, and the content-absent hint', () => {
    const html = renderToStaticMarkup(
      <InspectorPromptTab currentChat={chatWithEnvelope(envelope)} />
    )
    expect(html).toContain('Exact TaskWraith request (before provider adapter)')
    expect(html).toContain('TaskWraith runtime preamble')
    expect(html).toContain('Inherited')
    expect(html).toContain('already delivered to this provider session (digest match)')
    expect(html).toContain('Skipped')
    expect(html).toContain('symlink_refused')
    expect(html).toContain('instructions digest: digest-v1')
    expect(html).toContain('store raw events')
    expect(html).toContain('provider-owned context unavailable')
    expect(html).toContain('No wire-boundary capture for this run.')
  })

  it('renders wire captures with transforms when present', () => {
    const withWire: PromptEnvelopeSnapshot = {
      ...envelope,
      accuracy: 'wire',
      contentStored: true,
      wire: [
        {
          transport: 'grok-acp',
          attempt: 1,
          capturedAt: '2026-08-11T12:00:01Z',
          part: 'user',
          sha256: 'd'.repeat(64),
          bytes: 2100,
          content: 'the exact wire text',
          transforms: ['mode-preamble', 'goal-preamble']
        }
      ]
    }
    const html = renderToStaticMarkup(
      <InspectorPromptTab currentChat={chatWithEnvelope(withWire)} />
    )
    expect(html).toContain('Wire captured')
    expect(html).toContain('Attempt 1 — grok-acp (user)')
    expect(html).toContain('mode-preamble, goal-preamble')
    expect(html).toContain('the exact wire text')
  })

  it('explains the empty state when no run carries an envelope', () => {
    const html = renderToStaticMarkup(
      <InspectorPromptTab currentChat={chatWithEnvelope(undefined)} />
    )
    expect(html).toContain('No prompt envelope is recorded')
  })
})
