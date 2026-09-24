import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { WebContents } from 'electron'
import {
  ENSEMBLE_AGENT_POOL_REGISTRATION_REQUESTED_CHANNEL,
  ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL,
  ENSEMBLE_ROSTER_PRESETS_IMPORT_REQUESTED_CHANNEL,
  ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL,
  registerEnsembleRosterPresetAckHandlers,
  requestRendererAgentPoolRegistration,
  requestRendererRosterPresetImport,
  unregisterEnsembleRosterPresetAckHandlers,
  type EnsembleRosterAckWindow,
  type EnsembleRosterPresetAckHandlerDeps
} from './ensembleRosterPresetAckHandlers'
import type { EnsembleParticipant } from '../store/types'

type Listener = (event: unknown, payload: unknown) => void
const listeners = new Map<string, Listener>()

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    })
  }
}))

const WEB_CONTENTS_ID = 7
const EVENT = { sender: { id: WEB_CONTENTS_ID } }

function windowFixture(
  overrides: { destroyed?: boolean; contentsDestroyed?: boolean; id?: number } = {}
): EnsembleRosterAckWindow {
  return {
    isDestroyed: () => overrides.destroyed ?? false,
    webContents: {
      id: overrides.id ?? WEB_CONTENTS_ID,
      isDestroyed: () => overrides.contentsDestroyed ?? false
    } as unknown as WebContents
  }
}

type SendMock = Mock<
  (sender: WebContents | null | undefined, channel: string, payload: unknown) => boolean
>

interface Harness {
  deps: EnsembleRosterPresetAckHandlerDeps
  send: SendMock
  setWindow: (window: EnsembleRosterAckWindow | null) => void
  sentPayloads: () => Array<{ channel: string; payload: Record<string, unknown> }>
}

function harness(): Harness {
  const send: SendMock = vi.fn(() => true)
  let current: EnsembleRosterAckWindow | null = windowFixture()
  const deps: EnsembleRosterPresetAckHandlerDeps = {
    getMainWindow: () => current,
    sendToSender: send
  }
  registerEnsembleRosterPresetAckHandlers()
  return {
    deps,
    send,
    setWindow: (next) => (current = next),
    sentPayloads: () =>
      send.mock.calls.map(([, channel, payload]) => ({
        channel,
        payload: payload as Record<string, unknown>
      }))
  }
}

function listenerFor(channel: string): Listener {
  const listener = listeners.get(channel)
  expect(listener).toBeTypeOf('function')
  if (!listener) throw new Error(`Listener not registered: ${channel}`)
  return listener
}

function participantFixture(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'participant-1',
    provider: 'codex',
    enabled: true,
    role: 'worker',
    instructions: '',
    order: 0,
    ...overrides
  }
}

function identityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentId: 'pooled-agent-1',
    nickname: 'Pool Agent',
    iconKind: 'named',
    hue: 210,
    ...overrides
  }
}

describe('ensemble roster-preset ack handlers', () => {
  beforeEach(() => {
    listeners.clear()
  })

  it('registers exactly the two result channels', () => {
    harness()
    expect([...listeners.keys()].sort()).toEqual(
      [
        ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL,
        ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL
      ].sort()
    )
    expect(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL).toBe(
      'ensemble-roster-presets:import-result'
    )
    expect(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL).toBe(
      'ensemble-agent-pool:registration-result'
    )
  })

  it('unregisters both channels with their exact listeners', () => {
    harness()
    expect(listeners.size).toBe(2)
    unregisterEnsembleRosterPresetAckHandlers()
    expect(listeners.size).toBe(0)
  })

  it('ignores non-object result payloads without throwing', () => {
    harness()
    const roster = listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)
    const pool = listenerFor(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL)
    for (const bad of [null, undefined, 42, 'nope', ['array']]) {
      expect(() => roster(EVENT, bad)).not.toThrow()
      expect(() => pool(EVENT, bad)).not.toThrow()
    }
  })

  it('rejects the roster import when no window exists', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(null)
    await expect(requestRendererRosterPresetImport('{}', deps)).rejects.toThrow(
      'No active TaskWraith window can save the roster preset.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects the roster import when the window is destroyed', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(windowFixture({ destroyed: true }))
    await expect(requestRendererRosterPresetImport('{}', deps)).rejects.toThrow(
      'No active TaskWraith window can save the roster preset.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects the roster import when the webContents is destroyed', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(windowFixture({ contentsDestroyed: true }))
    await expect(requestRendererRosterPresetImport('{}', deps)).rejects.toThrow(
      'No active TaskWraith window can save the roster preset.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('resolves the roster import on a valid ack round-trip', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererRosterPresetImport('{"preset":true}', deps)
    const sent = sentPayloads()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe(ENSEMBLE_ROSTER_PRESETS_IMPORT_REQUESTED_CHANNEL)
    listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)(EVENT, {
      requestId: sent[0]?.payload.requestId,
      ok: true,
      importedCount: 1,
      presetId: 'preset-1',
      presetName: 'Preset One'
    })
    await expect(pending).resolves.toEqual({
      importedCount: 1,
      presetId: 'preset-1',
      presetName: 'Preset One'
    })
  })

  it('rejects the roster import when the send fails', async () => {
    const { deps, send } = harness()
    send.mockReturnValue(false)
    await expect(requestRendererRosterPresetImport('{}', deps)).rejects.toThrow(
      'The TaskWraith window closed before the roster preset could be saved.'
    )
  })

  it('rejects the roster import on timeout and ignores the late ack', async () => {
    vi.useFakeTimers()
    try {
      const { deps, sentPayloads } = harness()
      const pending = requestRendererRosterPresetImport('{}', deps)
      const requestId = sentPayloads()[0]?.payload.requestId
      const assertion = expect(pending).rejects.toThrow(
        'Timed out waiting for the roster preset to be saved.'
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      expect(() =>
        listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)(EVENT, {
          requestId,
          ok: true,
          importedCount: 1,
          presetId: 'preset-1',
          presetName: 'Preset One'
        })
      ).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects the roster import with the renderer error', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererRosterPresetImport('{}', deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)(EVENT, {
      requestId,
      ok: false,
      error: 'disk is full'
    })
    await expect(pending).rejects.toThrow('disk is full')
  })

  it('rejects the roster import with a default message when the renderer gives none', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererRosterPresetImport('{}', deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)(EVENT, { requestId, ok: false })
    await expect(pending).rejects.toThrow('The renderer could not save the roster preset.')
  })

  it('rejects the roster import when the receipt count is not exactly one', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererRosterPresetImport('{}', deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)(EVENT, {
      requestId,
      ok: true,
      importedCount: 2,
      presetId: 'preset-1',
      presetName: 'Preset One'
    })
    await expect(pending).rejects.toThrow(
      'The renderer returned an invalid roster preset save receipt.'
    )
  })

  it('ignores roster acks from a different webContents', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererRosterPresetImport('{}', deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    const ack = listenerFor(ENSEMBLE_ROSTER_PRESETS_IMPORT_RESULT_CHANNEL)
    ack({ sender: { id: 999 } }, { requestId, ok: false, error: 'WRONG-SENDER' })
    ack(EVENT, {
      requestId,
      ok: true,
      importedCount: 1,
      presetId: 'preset-1',
      presetName: 'Preset One'
    })
    await expect(pending).resolves.toEqual({
      importedCount: 1,
      presetId: 'preset-1',
      presetName: 'Preset One'
    })
  })

  it('rejects pool registration when no window exists', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(null)
    await expect(requestRendererAgentPoolRegistration(participantFixture(), deps)).rejects.toThrow(
      'No active TaskWraith window can register the Agent Pool entry.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects pool registration when the window is destroyed', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(windowFixture({ destroyed: true }))
    await expect(requestRendererAgentPoolRegistration(participantFixture(), deps)).rejects.toThrow(
      'No active TaskWraith window can register the Agent Pool entry.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects pool registration when the webContents is destroyed', async () => {
    const { deps, setWindow, send } = harness()
    setWindow(windowFixture({ contentsDestroyed: true }))
    await expect(requestRendererAgentPoolRegistration(participantFixture(), deps)).rejects.toThrow(
      'No active TaskWraith window can register the Agent Pool entry.'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('resolves pool registration on a valid receipt round-trip', async () => {
    const { deps, sentPayloads } = harness()
    const participant = participantFixture()
    const pending = requestRendererAgentPoolRegistration(participant, deps)
    const sent = sentPayloads()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe(ENSEMBLE_AGENT_POOL_REGISTRATION_REQUESTED_CHANNEL)
    expect(sent[0]?.payload.participant).toBe(participant)
    const identity = identityFixture()
    listenerFor(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL)(EVENT, {
      requestId: sent[0]?.payload.requestId,
      ok: true,
      pooledAgentId: 'pooled-agent-1',
      pooledAgentIdentity: identity,
      mode: 'created'
    })
    await expect(pending).resolves.toEqual({
      pooledAgentId: 'pooled-agent-1',
      pooledAgentIdentity: identity,
      mode: 'created'
    })
  })

  it('rejects pool registration when the send fails', async () => {
    const { deps, send } = harness()
    send.mockReturnValue(false)
    await expect(requestRendererAgentPoolRegistration(participantFixture(), deps)).rejects.toThrow(
      'The TaskWraith window closed before Agent Pool registration completed.'
    )
  })

  it('rejects pool registration on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = harness()
      const pending = requestRendererAgentPoolRegistration(participantFixture(), deps)
      const assertion = expect(pending).rejects.toThrow(
        'Timed out waiting for Agent Pool registration.'
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects pool registration with a default message when the renderer gives none', async () => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererAgentPoolRegistration(participantFixture(), deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    listenerFor(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL)(EVENT, {
      requestId,
      ok: false
    })
    await expect(pending).rejects.toThrow('The renderer could not register the Agent Pool entry.')
  })

  it.each([
    ['missing pooled-agent- prefix', { pooledAgentId: 'agent-1' }, {}],
    ['wrong schema version', {}, { schemaVersion: 2 }],
    ['agent id mismatch', {}, { agentId: 'pooled-agent-9' }],
    ['blank nickname', {}, { nickname: '   ' }],
    ['unknown icon kind', {}, { iconKind: 'bogus' }],
    ['non-finite hue', {}, { hue: Number.NaN }],
    ['unknown mode', { mode: 'deleted' }, {}]
  ])('rejects an invalid pool receipt: %s', async (_label, ackOverrides, identityOverrides) => {
    const { deps, sentPayloads } = harness()
    const pending = requestRendererAgentPoolRegistration(participantFixture(), deps)
    const requestId = sentPayloads()[0]?.payload.requestId
    listenerFor(ENSEMBLE_AGENT_POOL_REGISTRATION_RESULT_CHANNEL)(EVENT, {
      requestId,
      ok: true,
      pooledAgentId: 'pooled-agent-1',
      pooledAgentIdentity: identityFixture(identityOverrides),
      mode: 'coalesced',
      ...ackOverrides
    })
    await expect(pending).rejects.toThrow(
      'The renderer returned an invalid Agent Pool registration receipt.'
    )
  })
})
