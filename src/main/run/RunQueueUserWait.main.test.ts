import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'

const probe = new MainSourceProbe('index.ts', new URL('../index.ts', import.meta.url))

describe('run queue user-change replies in main', () => {
  it('waits on every successful cancellation reply, including prelaunch, queued, orphan and active runs', () => {
    const body = probe.fn('cancelProviderRun')
    const waits = probe.callsTo(body, 'afterRunQueueUserChange')
    expect(waits.map((call) => probe.argText(call, 0))).toEqual([
      'true',
      'true',
      'true',
      'cancelled'
    ])
    for (const call of waits) expect(ts.isReturnStatement(call.parent)).toBe(true)
  })

  it('waits before the remote steer-now reply', () => {
    const waits = probe.callsTo(probe.fn('steerRemoteComposerQueueJob'), 'afterRunQueueUserChange')
    expect(waits).toHaveLength(1)
    expect(probe.argText(waits[0], 0)).toBe(
      "ok ? { ok: true } : { ok: false, reason: 'Queued prompt could not be steered' }"
    )
    expect(ts.isReturnStatement(waits[0].parent)).toBe(true)
  })

  it('waits before the remote enqueue reply', () => {
    const waits = probe.callsTo(probe.fn('queueRemoteComposerPrompt'), 'afterRunQueueUserChange')
    expect(waits).toHaveLength(1)
    expect(probe.argText(waits[0], 0)).toBe('{ ok: true, queueId }')
    expect(ts.isReturnStatement(waits[0].parent)).toBe(true)
  })

  it('waits before the remote remove reply', () => {
    const waits = probe.callsTo(
      probe.fn('updateRemoteComposerQueueItem'),
      'afterRunQueueUserChange'
    )
    expect(waits).toHaveLength(1)
    expect(probe.argText(waits[0], 0)).toBe('{ ok: true }')
    expect(ts.isReturnStatement(waits[0].parent)).toBe(true)
  })
})
