import { describe, expect, it, vi } from 'vitest'
import {
  bindComposerReservation,
  type ComposerMutationObserverConstructor,
  type ComposerReservationWindowTarget,
  type ComposerResizeObserverConstructor
} from './composerReservation'

const fakeStack = (rows: number): Element =>
  ({ querySelectorAll: () => ({ length: rows }) }) as unknown as Element

const fakeComposer = (
  getHeight: () => number,
  getRows: () => number,
  isAboveRowsMinimized: () => boolean = () => false
): HTMLElement =>
  ({
    getBoundingClientRect: () => ({ height: getHeight() }) as DOMRect,
    querySelector: () => fakeStack(getRows()),
    classList: {
      contains: (className: string) =>
        className === 'composer-area--above-rows-minimized' && isAboveRowsMinimized()
    }
  }) as unknown as HTMLElement

const fakeTranscript = () => {
  const values = new Map<string, string>()
  const setProperty = vi.fn((name: string, value: string) => values.set(name, value))
  return {
    element: { style: { setProperty } } as unknown as HTMLElement,
    setProperty,
    values
  }
}

function observerHarness() {
  const resizeCallbacks: Array<() => void> = []
  const resizeTargets: Element[][] = []
  const resizeDisconnects: ReturnType<typeof vi.fn>[] = []
  const ResizeObserverCtor = class {
    private readonly targets: Element[] = []
    private readonly disconnectSpy = vi.fn()

    constructor(callback: () => void) {
      resizeCallbacks.push(callback)
      resizeTargets.push(this.targets)
      resizeDisconnects.push(this.disconnectSpy)
    }

    observe(target: Element) {
      this.targets.push(target)
    }

    disconnect() {
      this.disconnectSpy()
    }
  } as ComposerResizeObserverConstructor

  const mutationCallbacks: Array<() => void> = []
  const mutationDisconnects: ReturnType<typeof vi.fn>[] = []
  const MutationObserverCtor = class {
    private readonly disconnectSpy = vi.fn()

    constructor(callback: () => void) {
      mutationCallbacks.push(callback)
      mutationDisconnects.push(this.disconnectSpy)
    }

    observe(target: Element, options: MutationObserverInit) {
      void target
      void options
    }

    disconnect() {
      this.disconnectSpy()
    }
  } as ComposerMutationObserverConstructor

  return {
    MutationObserverCtor,
    ResizeObserverCtor,
    mutationCallbacks,
    mutationDisconnects,
    resizeCallbacks,
    resizeDisconnects,
    resizeTargets
  }
}

describe('bindComposerReservation', () => {
  it('measures immediately, follows grow/shrink and above rows, and skips duplicate writes', () => {
    let height = 287.2
    let rows = 3
    const transcript = fakeTranscript()
    const composer = fakeComposer(
      () => height,
      () => rows
    )
    const observers = observerHarness()
    const windowTarget = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as ComposerReservationWindowTarget

    const cleanup = bindComposerReservation({
      transcript: transcript.element,
      composerArea: composer,
      resizeObserverCtor: observers.ResizeObserverCtor,
      mutationObserverCtor: observers.MutationObserverCtor,
      windowTarget
    })

    expect(transcript.values.get('--composer-reserved-height')).toBe('288px')
    expect(transcript.values.get('--composer-above-row-clearance')).toBe('40px')
    expect(observers.resizeTargets[0]).toHaveLength(2)
    expect(transcript.setProperty).toHaveBeenCalledTimes(2)

    observers.resizeCallbacks[0]?.()
    expect(transcript.setProperty).toHaveBeenCalledTimes(2)

    height = 429.1
    rows = 1
    observers.resizeCallbacks[0]?.()
    expect(transcript.values.get('--composer-reserved-height')).toBe('430px')
    expect(transcript.values.get('--composer-above-row-clearance')).toBe('0px')

    height = 175.1
    observers.mutationCallbacks[0]?.()
    expect(transcript.values.get('--composer-reserved-height')).toBe('176px')

    cleanup()
    expect(observers.resizeDisconnects[0]).toHaveBeenCalledOnce()
    expect(observers.mutationDisconnects[0]).toHaveBeenCalledOnce()
    expect(windowTarget.removeEventListener).toHaveBeenCalledOnce()
  })

  it('keeps simultaneous pane bindings isolated', () => {
    let heightA = 181.2
    const heightB = 314.1
    const paneA = fakeTranscript()
    const paneB = fakeTranscript()
    const observers = observerHarness()

    const cleanupA = bindComposerReservation({
      transcript: paneA.element,
      composerArea: fakeComposer(
        () => heightA,
        () => 0
      ),
      resizeObserverCtor: observers.ResizeObserverCtor,
      mutationObserverCtor: null,
      windowTarget: null
    })
    const cleanupB = bindComposerReservation({
      transcript: paneB.element,
      composerArea: fakeComposer(
        () => heightB,
        () => 0
      ),
      resizeObserverCtor: observers.ResizeObserverCtor,
      mutationObserverCtor: null,
      windowTarget: null
    })

    expect(paneA.values.get('--composer-reserved-height')).toBe('182px')
    expect(paneB.values.get('--composer-reserved-height')).toBe('315px')
    heightA = 401.2
    observers.resizeCallbacks[0]?.()
    expect(paneA.values.get('--composer-reserved-height')).toBe('402px')
    expect(paneB.values.get('--composer-reserved-height')).toBe('315px')

    cleanupA()
    cleanupB()
  })

  it('drops the extra transcript clearance while composer above rows are minimized', () => {
    let minimized = false
    const transcript = fakeTranscript()
    const observers = observerHarness()
    const cleanup = bindComposerReservation({
      transcript: transcript.element,
      composerArea: fakeComposer(
        () => 287,
        () => 3,
        () => minimized
      ),
      resizeObserverCtor: observers.ResizeObserverCtor,
      mutationObserverCtor: observers.MutationObserverCtor,
      windowTarget: null
    })

    expect(transcript.values.get('--composer-above-row-clearance')).toBe('40px')

    minimized = true
    observers.mutationCallbacks[0]?.()

    expect(transcript.values.get('--composer-above-row-clearance')).toBe('0px')
    cleanup()
  })

  it('uses window resize as a no-ResizeObserver fallback and ignores zero height', () => {
    let height = 0
    const transcript = fakeTranscript()
    const resizeListeners: Array<() => void> = []
    const windowTarget: ComposerReservationWindowTarget = {
      addEventListener: (_type, listener) => {
        resizeListeners.push(listener)
      },
      removeEventListener: vi.fn()
    }

    const cleanup = bindComposerReservation({
      transcript: transcript.element,
      composerArea: fakeComposer(
        () => height,
        () => 0
      ),
      resizeObserverCtor: null,
      mutationObserverCtor: null,
      windowTarget
    })
    expect(transcript.setProperty).not.toHaveBeenCalled()

    height = 219.2
    resizeListeners[0]?.()
    expect(transcript.values.get('--composer-reserved-height')).toBe('220px')
    cleanup()
    expect(windowTarget.removeEventListener).toHaveBeenCalledOnce()
  })
})
