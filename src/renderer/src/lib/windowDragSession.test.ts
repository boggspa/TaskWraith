import { describe, expect, it, vi } from 'vitest'
import { createWindowDragSession } from './windowDragSession'

function fakeWindow(): {
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>
  listeners: Map<string, Set<EventListener>>
} {
  const listeners = new Map<string, Set<EventListener>>()
  return {
    listeners,
    target: {
      addEventListener: ((type: string, handler: EventListener) => {
        const set = listeners.get(type) ?? new Set<EventListener>()
        listeners.set(type, set)
        set.add(handler)
      }) as Window['addEventListener'],
      removeEventListener: ((type: string, handler: EventListener) => {
        listeners.get(type)?.delete(handler)
      }) as Window['removeEventListener']
    }
  }
}

const liveCount = (listeners: Map<string, Set<EventListener>>): number =>
  [...listeners.values()].reduce((total, set) => total + set.size, 0)

describe('createWindowDragSession', () => {
  it('attaches move/end listeners while the drag runs', () => {
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    session.begin({ onMove: vi.fn(), onEnd: vi.fn() })
    expect(liveCount(listeners)).toBe(2)
  })

  it('detaches when the drag ends normally', () => {
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    const onEnd = vi.fn()
    session.begin({ onMove: vi.fn(), onEnd })
    listeners.get('mouseup')?.forEach((handler) => handler(new Event('mouseup')))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(liveCount(listeners)).toBe(0)
  })

  it('detaches on dispose when the drag never ends', () => {
    // The leak: a Multiview pane can unmount mid-drag (pane close, or the
    // focus-steal swapping the focused cell), so mouseup never arrives and
    // both listeners survive holding the component closure.
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    session.begin({ onMove: vi.fn(), onEnd: vi.fn() })
    session.dispose()
    expect(liveCount(listeners)).toBe(0)
  })

  it('does not run the end callback when disposed mid-drag', () => {
    // Unmount must not commit drag state to a dead component.
    const { target } = fakeWindow()
    const session = createWindowDragSession(target)
    const onEnd = vi.fn()
    session.begin({ onMove: vi.fn(), onEnd })
    session.dispose()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('replaces a previous drag rather than stacking listeners', () => {
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    session.begin({ onMove: vi.fn(), onEnd: vi.fn() })
    session.begin({ onMove: vi.fn(), onEnd: vi.fn() })
    expect(liveCount(listeners)).toBe(2)
    session.dispose()
    expect(liveCount(listeners)).toBe(0)
  })

  it('is idempotent, so end-then-unmount cannot double-detach', () => {
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    const onEnd = vi.fn()
    session.begin({ onMove: vi.fn(), onEnd })
    listeners.get('mouseup')?.forEach((handler) => handler(new Event('mouseup')))
    session.dispose()
    session.dispose()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(liveCount(listeners)).toBe(0)
  })

  it('forwards move events to the caller', () => {
    const { target, listeners } = fakeWindow()
    const session = createWindowDragSession(target)
    const onMove = vi.fn()
    session.begin({ onMove, onEnd: vi.fn() })
    const move = new Event('mousemove')
    listeners.get('mousemove')?.forEach((handler) => handler(move))
    expect(onMove).toHaveBeenCalledWith(move)
  })
})
