import { describe, expect, it } from 'vitest'

import type {
  HostProviderRunEvent,
  HostProviderRunPort,
  HostProviderRunThread
} from './HostProviderRunPort'
import {
  normalizeHostProviderRunEvent,
  normalizeHostProviderRunTranscriptAppend,
  normalizeHostProviderRunUsage,
  normalizeHostProviderRunWarnings,
  validateHostProviderRunPrompt
} from './HostProviderRunPort'
import type { HostRunEventTarget } from './HostRunEventTarget'

function configuredMuseThread(): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    workspace: {
      workspaceId: 'workspace-1',
      canonicalPath: '/tmp/workspace',
      canonical: true
    },
    providerId: 'muse',
    modelId: 'muse-spark-1.2',
    posture: {
      postureId: 'workspace-write',
      approvalMode: 'default',
      requiresExplicitConsent: true,
      explicitConsentAcknowledged: true
    }
  }
}

describe('HostProviderRunPort', () => {
  it('accepts ordinary multiline intent but rejects unsafe controls and over-limit text', () => {
    expect(validateHostProviderRunPrompt('first line\n\tsecond line\r\n')).toBe(true)
    expect(validateHostProviderRunPrompt(`bad\u0000control`)).toBe(false)
    expect(validateHostProviderRunPrompt('x'.repeat(16_001))).toBe(false)
    expect(
      normalizeHostProviderRunTranscriptAppend({
        threadId: 'thread-1',
        runId: 'run-1',
        role: 'user',
        text: 'first line\nsecond line',
        createdAt: '2026-08-24T05:00:00.000Z'
      })
    ).toMatchObject({ text: 'first line\nsecond line' })
    expect(
      normalizeHostProviderRunTranscriptAppend({
        threadId: 'thread-1',
        runId: 'run-1',
        role: 'user',
        text: 'bad\u0000control',
        createdAt: '2026-08-24T05:00:00.000Z'
      })
    ).toBeNull()
  })

  it('rejects unknown or non-finite usage and keeps events body-free/bounded', () => {
    expect(normalizeHostProviderRunUsage({ inputTokens: Number.NaN })).toBeNull()
    expect(normalizeHostProviderRunUsage({ outputTokens: -1 })).toBeNull()
    expect(normalizeHostProviderRunUsage({ unknown: 1 } as never)).toBeNull()
    expect(normalizeHostProviderRunWarnings([`token=secret-value`])).toEqual(['token=[redacted]'])
    expect(
      normalizeHostProviderRunEvent({
        type: 'run.content',
        runId: 'run-1',
        threadId: 'thread-1',
        text: `token=secret-value ${'x'.repeat(5_000)}`,
        at: '2026-08-24T05:00:00.000Z'
      })
    ).toMatchObject({ type: 'run.content', text: expect.stringContaining('[redacted]') })
    expect(
      normalizeHostProviderRunEvent({
        type: 'run.tool',
        runId: 'run-1',
        threadId: 'thread-1',
        toolId: 'tool-1',
        phase: 'started',
        at: 'not-a-timestamp'
      })
    ).toBeNull()
  })

  it('accepts a Node delivery target and bounded event without Electron fields', () => {
    const target = { id: 'node-host-client' } satisfies HostRunEventTarget
    const thread = configuredMuseThread()
    const events: HostProviderRunEvent[] = []
    const port: HostProviderRunPort = {
      getThread: (threadId) => (threadId === thread.threadId ? thread : null),
      appendTranscript(input) {
        void input
      },
      beginRun: () => ({ kind: 'started' }),
      updateRun(input) {
        void input
      },
      finishRun(input) {
        void input
      },
      registerCancel() {
        return { kind: 'registered' }
      },
      clearCancel(runId) {
        void runId
      },
      publishRunEvent: (_target, event) => events.push(event)
    }

    port.publishRunEvent(target, {
      type: 'run.content',
      runId: 'run-1',
      threadId: thread.threadId,
      text: 'bounded output',
      at: '2026-08-24T05:00:00.000Z'
    })

    expect(events).toEqual([
      expect.objectContaining({ type: 'run.content', text: 'bounded output' })
    ])
  })
})
