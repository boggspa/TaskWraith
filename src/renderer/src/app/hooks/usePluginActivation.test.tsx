import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskWraithPluginActivationSnapshot } from '../../../../shared/plugins/PluginTypes'
import { usePluginActivation, type UsePluginActivationResult } from './usePluginActivation'

type Api = Window['api']
let root: Root | null = null
let currentResult: UsePluginActivationResult | null = null
let snapshots: Array<TaskWraithPluginActivationSnapshot | null> = []

function activation(generatedAt: string): TaskWraithPluginActivationSnapshot {
  return {
    schemaVersion: 1,
    generatedAt,
    mcpServers: [],
    runtimeProfileIds: [],
    taskwraithToolBundles: [],
    workflowTemplates: [],
    connectors: [],
    localServices: [],
    providerSetup: [],
    mobileRemoteProjection: [],
    materializedResources: [],
    counts: {
      enabledPlugins: 0,
      mcpServers: 0,
      runtimeProfiles: 0,
      taskwraithToolBundles: 0,
      workflowTemplates: 0,
      connectors: 0,
      localServices: 0,
      providerSetup: 0,
      mobileRemoteProjection: 0
    }
  }
}

function Observer({ initialState }: { initialState: TaskWraithPluginActivationSnapshot | null }) {
  const result = usePluginActivation(initialState)
  useLayoutEffect(() => {
    currentResult = result
  }, [result])
  useLayoutEffect(() => {
    snapshots.push(result.pluginActivation)
  }, [result.pluginActivation])
  return null
}

function mount(
  api: Partial<Api> = {},
  initialState: TaskWraithPluginActivationSnapshot | null = null
) {
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
  const addEventListener = vi.spyOn(windowTarget, 'addEventListener')
  const removeEventListener = vi.spyOn(windowTarget, 'removeEventListener')
  snapshots = []
  currentResult = null
  root = createRoot(container)
  act(() => root!.render(<Observer initialState={initialState} />))
  return { windowTarget, addEventListener, removeEventListener }
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

function currentSnapshot(): TaskWraithPluginActivationSnapshot | null {
  return snapshots[snapshots.length - 1]
}

async function dispatchActivationChanged(windowTarget: EventTarget): Promise<void> {
  await act(async () => {
    windowTarget.dispatchEvent(new Event('taskwraith-plugin-activation-changed'))
    await Promise.resolve()
  })
}

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('usePluginActivation', () => {
  it('starts empty and listens without fetching eagerly', () => {
    const getPluginActivation = vi.fn<Api['getPluginActivation']>()
    const harness = mount({ getPluginActivation })
    expect(snapshots).toEqual([null])
    expect(getPluginActivation).not.toHaveBeenCalled()
    expect(harness.addEventListener).toHaveBeenCalledExactlyOnceWith(
      'taskwraith-plugin-activation-changed',
      expect.any(Function)
    )
  })

  it('accepts an initial snapshot and exposes the setter used by initial loading', () => {
    const initial = activation('initial')
    const loaded = activation('loaded')
    mount({}, initial)
    expect(currentSnapshot()).toBe(initial)
    act(() => currentResult!.setPluginActivation(loaded))
    expect(currentSnapshot()).toBe(loaded)
  })

  it('keeps its state, callbacks, and single listener across rerenders', () => {
    const initial = activation('initial')
    const harness = mount({}, initial)
    const previousSet = currentResult!.setPluginActivation
    const previousRefresh = currentResult!.refreshPluginActivation
    const snapshotCount = snapshots.length
    act(() => root!.render(<Observer initialState={activation('ignored-after-mount')} />))
    expect(currentSnapshot()).toBe(initial)
    expect(snapshots).toHaveLength(snapshotCount)
    expect(currentResult!.setPluginActivation).toBe(previousSet)
    expect(currentResult!.refreshPluginActivation).toBe(previousRefresh)
    expect(harness.addEventListener).toHaveBeenCalledTimes(1)
    expect(harness.removeEventListener).not.toHaveBeenCalled()
  })

  it('refreshes after the activation-changed event', async () => {
    const refreshed = activation('refreshed')
    const getPluginActivation = vi.fn<Api['getPluginActivation']>().mockResolvedValue(refreshed)
    const harness = mount({ getPluginActivation }, activation('initial'))
    await dispatchActivationChanged(harness.windowTarget)
    expect(getPluginActivation).toHaveBeenCalledExactlyOnceWith()
    expect(currentSnapshot()).toBe(refreshed)
  })

  it('keeps the current snapshot when the optional preload API is unavailable', async () => {
    const initial = activation('initial')
    const harness = mount({}, initial)
    await dispatchActivationChanged(harness.windowTarget)
    expect(currentSnapshot()).toBe(initial)
    expect(snapshots).toEqual([initial])
  })

  it('clears the snapshot when refresh rejects', async () => {
    const getPluginActivation = vi
      .fn<Api['getPluginActivation']>()
      .mockRejectedValue(new Error('Unavailable'))
    const harness = mount({ getPluginActivation }, activation('initial'))
    await dispatchActivationChanged(harness.windowTarget)
    expect(currentSnapshot()).toBeNull()
  })

  it('allows an explicit refresh through the returned callback', async () => {
    const refreshed = activation('explicit')
    const getPluginActivation = vi.fn<Api['getPluginActivation']>().mockResolvedValue(refreshed)
    mount({ getPluginActivation })
    await act(async () => currentResult!.refreshPluginActivation())
    expect(currentSnapshot()).toBe(refreshed)
  })

  it('removes the listener on unmount and ignores later events', async () => {
    const getPluginActivation = vi
      .fn<Api['getPluginActivation']>()
      .mockResolvedValue(activation('late'))
    const harness = mount({ getPluginActivation })
    const listener = harness.addEventListener.mock.calls[0][1]
    unmount()
    expect(harness.removeEventListener).toHaveBeenCalledExactlyOnceWith(
      'taskwraith-plugin-activation-changed',
      listener
    )
    await dispatchActivationChanged(harness.windowTarget)
    expect(getPluginActivation).not.toHaveBeenCalled()
  })
})
