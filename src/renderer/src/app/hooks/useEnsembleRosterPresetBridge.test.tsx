import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteEnsembleRosterPreset,
  importEnsembleRosterPresetsFromJson,
  listEnsembleRosterPresets,
  saveEnsembleRosterPresetFromParticipants,
  subscribeEnsembleRosterPresets,
  type EnsembleRosterPreset
} from '../../lib/ensembleRosterPresets'
import {
  pooledAgentIdentitySnapshot,
  registerParticipantInAgentPool,
  type PooledAgent
} from '../../lib/ensembleAgentPool'
import { useEnsembleRosterPresetBridge } from './useEnsembleRosterPresetBridge'

vi.mock('../../lib/ensembleRosterPresets', () => ({
  deleteEnsembleRosterPreset: vi.fn(),
  importEnsembleRosterPresetsFromJson: vi.fn(),
  listEnsembleRosterPresets: vi.fn(),
  saveEnsembleRosterPresetFromParticipants: vi.fn(),
  subscribeEnsembleRosterPresets: vi.fn()
}))
vi.mock('../../lib/ensembleAgentPool', () => ({
  pooledAgentIdentitySnapshot: vi.fn(),
  registerParticipantInAgentPool: vi.fn()
}))

type Api = Window['api']
type SavePayload = Parameters<Parameters<Api['onEnsembleRosterPresetSaveRequested']>[0]>[0]
type ImportPayload = Parameters<Parameters<Api['onEnsembleRosterPresetImportRequested']>[0]>[0]
type PoolPayload = Parameters<Parameters<Api['onEnsembleAgentPoolRegistrationRequested']>[0]>[0]

let root: Root | null = null
let cleanupOrder: string[] = []

function eventSource<T>(label: string) {
  let listener: ((value: T) => void) | undefined
  const off = vi.fn(() => {
    cleanupOrder.push(label)
    listener = undefined
  })
  return {
    off,
    subscribe: vi.fn((callback: (value: T) => void) => {
      listener = callback
      return off
    }),
    emit(value: T) {
      if (!listener) throw new Error('No active ' + label + ' listener')
      listener(value)
    }
  }
}

function bridgeHarness() {
  const save = eventSource<SavePayload>('save')
  const importPreset = eventSource<ImportPayload>('import')
  const pool = eventSource<PoolPayload>('pool')
  const remove = eventSource<string>('delete')
  const api = {
    syncEnsembleRosterPresets: vi.fn<Api['syncEnsembleRosterPresets']>().mockResolvedValue(),
    onEnsembleRosterPresetSaveRequested: save.subscribe,
    onEnsembleRosterPresetImportRequested: importPreset.subscribe,
    onEnsembleAgentPoolRegistrationRequested: pool.subscribe,
    onEnsembleRosterPresetDeleteRequested: remove.subscribe,
    sendEnsembleRosterPresetImportResult: vi.fn<Api['sendEnsembleRosterPresetImportResult']>(),
    sendEnsembleAgentPoolRegistrationResult: vi.fn<Api['sendEnsembleAgentPoolRegistrationResult']>()
  } satisfies Partial<Api>
  return { api, save, importPreset, pool, remove }
}

// This observer renders no host elements. Use the same minimal DOM convention
// as useChatTranscriptScheduling.test.tsx to exercise real React effects.
function mount(api: Partial<Api>, popout = false): void {
  class MinimalElement extends EventTarget {
    readonly nodeType = 1
  }
  class MinimalIFrame extends MinimalElement {}
  const documentTarget = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: {}
  })
  const windowTarget = Object.assign(new EventTarget(), {
    document: documentTarget,
    HTMLElement: MinimalElement,
    HTMLIFrameElement: MinimalIFrame,
    api
  })
  Object.assign(documentTarget, { defaultView: windowTarget })
  vi.stubGlobal('window', windowTarget)
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = Object.assign(new MinimalElement(), {
    ownerDocument: documentTarget,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    firstChild: null,
    appendChild: () => undefined,
    removeChild: () => undefined
  }) as unknown as Element
  root = createRoot(container)
  render(popout)
}

function Observer({ popout }: { popout: boolean }) {
  useEnsembleRosterPresetBridge(popout)
  return null
}

function render(popout: boolean): void {
  act(() => root!.render(<Observer popout={popout} />))
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

const preset: EnsembleRosterPreset = {
  id: 'preset-1',
  name: 'Reviewers',
  createdAt: 1,
  updatedAt: 2,
  orchestrationMode: 'continuous',
  maxParticipants: 5,
  participants: []
}
const agent: PooledAgent = {
  agentId: 'pooled-agent-1',
  createdAt: 1,
  updatedAt: 2,
  schemaVersion: 1,
  identity: { nickname: 'Reviewer', iconKind: 'seed', hue: 180 },
  config: { provider: 'codex', role: 'Reviewer', instructions: 'Review changes.' }
}

beforeEach(() => {
  vi.resetAllMocks()
  cleanupOrder = []
  vi.mocked(listEnsembleRosterPresets).mockReturnValue([preset])
  vi.mocked(subscribeEnsembleRosterPresets).mockReturnValue(() => {
    cleanupOrder.push('presets')
  })
})

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('useEnsembleRosterPresetBridge', () => {
  it('syncs initially and on changes, keeps subscriptions on rerender, and cleans all five in order', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenCalledExactlyOnceWith([preset])
    expect(subscribeEnsembleRosterPresets).toHaveBeenCalledOnce()
    for (const source of [bridge.save, bridge.importPreset, bridge.pool, bridge.remove]) {
      expect(source.subscribe).toHaveBeenCalledOnce()
    }

    render(false)
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenCalledTimes(1)
    expect(subscribeEnsembleRosterPresets).toHaveBeenCalledTimes(1)

    const changed = { ...preset, name: 'Updated' }
    vi.mocked(listEnsembleRosterPresets).mockReturnValue([changed])
    act(() => vi.mocked(subscribeEnsembleRosterPresets).mock.calls[0][0]())
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenLastCalledWith([changed])

    unmount()
    expect(cleanupOrder).toEqual(['presets', 'save', 'import', 'pool', 'delete'])
    for (const source of [bridge.save, bridge.importPreset, bridge.pool, bridge.remove]) {
      expect(source.off).toHaveBeenCalledOnce()
    }
    expect(() => bridge.remove.emit('preset-1')).toThrow('No active delete listener')
  })

  it('does not read, sync, or subscribe in a popout', () => {
    const bridge = bridgeHarness()
    mount(bridge.api, true)
    expect(listEnsembleRosterPresets).not.toHaveBeenCalled()
    expect(subscribeEnsembleRosterPresets).not.toHaveBeenCalled()
    expect(bridge.api.syncEnsembleRosterPresets).not.toHaveBeenCalled()
    for (const source of [bridge.save, bridge.importPreset, bridge.pool, bridge.remove]) {
      expect(source.subscribe).not.toHaveBeenCalled()
    }
    unmount()
    expect(cleanupOrder).toEqual([])
  })

  it('cleans up when becoming a popout and syncs afresh when becoming the main window', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    render(true)
    expect(cleanupOrder).toEqual(['presets', 'save', 'import', 'pool', 'delete'])
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenCalledTimes(1)
    render(false)
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenCalledTimes(2)
    expect(subscribeEnsembleRosterPresets).toHaveBeenCalledTimes(2)
    for (const source of [bridge.save, bridge.importPreset, bridge.pool, bridge.remove]) {
      expect(source.subscribe).toHaveBeenCalledTimes(2)
    }
  })

  it('tolerates older preloads without optional sync or request subscriptions', () => {
    expect(() => mount({})).not.toThrow()
    expect(subscribeEnsembleRosterPresets).toHaveBeenCalledOnce()
    expect(() =>
      act(() => vi.mocked(subscribeEnsembleRosterPresets).mock.calls[0][0]())
    ).not.toThrow()
    unmount()
    expect(cleanupOrder).toEqual(['presets'])
  })

  it('keeps listening after synchronous or asynchronous sync failures', async () => {
    const bridge = bridgeHarness()
    bridge.api.syncEnsembleRosterPresets.mockImplementationOnce(() => {
      throw new Error('Old bridge')
    })
    expect(() => mount(bridge.api)).not.toThrow()
    bridge.api.syncEnsembleRosterPresets.mockRejectedValueOnce(new Error('Disconnected'))
    await act(async () => vi.mocked(subscribeEnsembleRosterPresets).mock.calls[0][0]())
    expect(bridge.save.subscribe).toHaveBeenCalledOnce()
    expect(bridge.api.syncEnsembleRosterPresets).toHaveBeenCalledTimes(2)
  })

  it('passes saves through, defaults missing participants, and ignores malformed saves', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    const participants = [{ provider: 'codex', role: 'Reviewer' }]
    bridge.save.emit({ name: 'Reviewers', participants })
    expect(saveEnsembleRosterPresetFromParticipants).toHaveBeenLastCalledWith(
      'Reviewers',
      participants
    )
    bridge.save.emit({ name: 'Empty' } as SavePayload)
    expect(saveEnsembleRosterPresetFromParticipants).toHaveBeenLastCalledWith('Empty', [])
    vi.mocked(saveEnsembleRosterPresetFromParticipants).mockImplementationOnce(() => {
      throw new Error('Malformed')
    })
    expect(() => bridge.save.emit({ name: '', participants: [] })).not.toThrow()
  })

  it('replies to import success with the request id, count, and first saved preset', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    vi.mocked(importEnsembleRosterPresetsFromJson).mockReturnValue({
      importedCount: 2,
      skippedCount: 1,
      presets: [preset, { ...preset, id: 'preset-2' }]
    })
    bridge.importPreset.emit({ requestId: 'import-1', json: 'roster-json', source: 'ios' })
    expect(importEnsembleRosterPresetsFromJson).toHaveBeenCalledExactlyOnceWith('roster-json')
    expect(bridge.api.sendEnsembleRosterPresetImportResult).toHaveBeenCalledExactlyOnceWith({
      requestId: 'import-1',
      ok: true,
      importedCount: 2,
      presetId: preset.id,
      presetName: preset.name
    })
  })

  it.each([
    [new Error('Invalid roster'), 'Invalid roster'],
    ['invalid', 'Roster preset import failed.']
  ])('preserves import failure replies for %s', (failure, error) => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    vi.mocked(importEnsembleRosterPresetsFromJson).mockImplementationOnce(() => {
      throw failure
    })
    bridge.importPreset.emit({ requestId: 'import-failed', json: 'invalid' })
    expect(bridge.api.sendEnsembleRosterPresetImportResult).toHaveBeenCalledExactlyOnceWith({
      requestId: 'import-failed',
      ok: false,
      error
    })
  })

  it('reports an import with no first saved preset as a failure', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    vi.mocked(importEnsembleRosterPresetsFromJson).mockReturnValue({
      importedCount: 0,
      skippedCount: 0,
      presets: []
    })
    bridge.importPreset.emit({ requestId: 'import-empty', json: '[]' })
    expect(bridge.api.sendEnsembleRosterPresetImportResult).toHaveBeenCalledExactlyOnceWith({
      requestId: 'import-empty',
      ok: false,
      error: expect.any(String)
    })
  })

  it.each(['created', 'coalesced', 'updated'] as const)(
    'replies to pool registration with the exact identity and %s mode',
    (mode) => {
      const bridge = bridgeHarness()
      mount(bridge.api)
      const identity = {
        schemaVersion: 1 as const,
        agentId: agent.agentId,
        nickname: 'Reviewer',
        iconKind: 'seed' as const,
        hue: 180
      }
      vi.mocked(registerParticipantInAgentPool).mockReturnValue({ agent, mode })
      vi.mocked(pooledAgentIdentitySnapshot).mockReturnValue(identity)
      bridge.pool.emit({ requestId: 'pool-1', participant: agent.config })
      expect(registerParticipantInAgentPool).toHaveBeenCalledExactlyOnceWith(agent.config)
      expect(pooledAgentIdentitySnapshot).toHaveBeenCalledExactlyOnceWith(agent)
      expect(bridge.api.sendEnsembleAgentPoolRegistrationResult).toHaveBeenCalledExactlyOnceWith({
        requestId: 'pool-1',
        ok: true,
        pooledAgentId: agent.agentId,
        pooledAgentIdentity: identity,
        mode
      })
    }
  )

  it.each([
    [new Error('Invalid participant'), 'Invalid participant'],
    ['invalid', 'Agent Pool registration failed.']
  ])('preserves pool registration failure replies for %s', (failure, error) => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    vi.mocked(registerParticipantInAgentPool).mockImplementationOnce(() => {
      throw failure
    })
    bridge.pool.emit({ requestId: 'pool-failed', participant: {} })
    expect(bridge.api.sendEnsembleAgentPoolRegistrationResult).toHaveBeenCalledExactlyOnceWith({
      requestId: 'pool-failed',
      ok: false,
      error
    })
  })

  it('passes deletes through and ignores delete failures', () => {
    const bridge = bridgeHarness()
    mount(bridge.api)
    bridge.remove.emit('preset-1')
    expect(deleteEnsembleRosterPreset).toHaveBeenCalledExactlyOnceWith('preset-1')
    vi.mocked(deleteEnsembleRosterPreset).mockImplementationOnce(() => {
      throw new Error('Malformed')
    })
    expect(() => bridge.remove.emit('bad-id')).not.toThrow()
  })
})
