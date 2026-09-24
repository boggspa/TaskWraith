import { describe, expect, it, vi } from 'vitest'
import { createSystemAccentColorSource, type SystemAccentColorDeps } from './SystemAccentColor'

vi.mock('electron', () => ({
  systemPreferences: {
    getAccentColor: () => '',
    subscribeNotification: () => 0,
    unsubscribeNotification: () => {},
    on: () => {},
    off: () => {}
  }
}))

function createDeps(overrides: Partial<SystemAccentColorDeps> = {}) {
  const notificationSubscribers = new Map<number, () => void>()
  const accentEventListeners = new Set<() => void>()
  let nextSubscriptionId = 1
  const deps: SystemAccentColorDeps = {
    platform: 'darwin',
    getAccentColor: () => '1e90ffff',
    subscribeNotification: vi.fn((_event: string, callback: () => void) => {
      const id = nextSubscriptionId++
      notificationSubscribers.set(id, callback)
      return id
    }),
    unsubscribeNotification: vi.fn((id: number) => {
      notificationSubscribers.delete(id)
    }),
    onAccentColorChanged: vi.fn((callback: () => void) => {
      accentEventListeners.add(callback)
    }),
    offAccentColorChanged: vi.fn((callback: () => void) => {
      accentEventListeners.delete(callback)
    }),
    ...overrides
  }
  const fireNotifications = (): void => {
    for (const callback of [...notificationSubscribers.values()]) callback()
  }
  const fireAccentEvent = (): void => {
    for (const callback of [...accentEventListeners]) callback()
  }
  return { deps, fireNotifications, fireAccentEvent, notificationSubscribers, accentEventListeners }
}

describe('createSystemAccentColorSource', () => {
  it('reads the OS accent as a plain hex colour', () => {
    const { deps } = createDeps()
    expect(createSystemAccentColorSource(deps).read()).toBe('#1E90FF')
  })

  it('reports null when the host throws instead of answering', () => {
    // getAccentColor() throws (not returns falsy) where the platform has no
    // accent preference. A throw must read as "leave --accent alone", never
    // as a crash on the IPC handler.
    const { deps } = createDeps({
      getAccentColor: () => {
        throw new Error('Not available on this platform')
      }
    })
    expect(createSystemAccentColorSource(deps).read()).toBeNull()
  })

  it('watches the macOS colour-preferences notification on darwin', () => {
    let accent = '1e90ffff'
    const { deps, fireNotifications, accentEventListeners } = createDeps({
      platform: 'darwin',
      getAccentColor: () => accent
    })
    const onChange = vi.fn()
    createSystemAccentColorSource(deps).watch(onChange)

    // macOS has no 'accent-color-changed' event; subscribing to it there would
    // be a watcher that never fires.
    expect(accentEventListeners.size).toBe(0)
    expect(deps.subscribeNotification).toHaveBeenCalledWith(
      'AppleColorPreferencesChangedNotification',
      expect.any(Function)
    )

    accent = 'ff375fff'
    fireNotifications()
    expect(onChange).toHaveBeenCalledWith('#FF375F')
  })

  it('watches the accent-color-changed event off darwin', () => {
    let accent = '1e90ffff'
    const { deps, fireAccentEvent, notificationSubscribers } = createDeps({
      platform: 'win32',
      getAccentColor: () => accent
    })
    const onChange = vi.fn()
    createSystemAccentColorSource(deps).watch(onChange)

    expect(notificationSubscribers.size).toBe(0)
    accent = '#00cc88'
    fireAccentEvent()
    expect(onChange).toHaveBeenCalledWith('#00CC88')
  })

  it('stays silent when a notification carries no accent change', () => {
    // macOS posts this notification for highlight-colour and appearance
    // changes too. The renderer's apply path rewrites ~20 root attributes per
    // call and restarts the CSS animations gated on them, so a repeat must
    // not reach it.
    const { deps, fireNotifications } = createDeps({ getAccentColor: () => '1e90ffff' })
    const onChange = vi.fn()
    createSystemAccentColorSource(deps).watch(onChange)

    fireNotifications()
    fireNotifications()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports a change back to null when the host stops answering', () => {
    let accent = '1e90ffff'
    const { deps, fireNotifications } = createDeps({ getAccentColor: () => accent })
    const onChange = vi.fn()
    createSystemAccentColorSource(deps).watch(onChange)

    accent = ''
    fireNotifications()
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('detaches both platform listeners on unsubscribe', () => {
    const darwin = createDeps({ platform: 'darwin' })
    createSystemAccentColorSource(darwin.deps).watch(vi.fn())()
    expect(darwin.notificationSubscribers.size).toBe(0)

    const windows = createDeps({ platform: 'win32' })
    createSystemAccentColorSource(windows.deps).watch(vi.fn())()
    expect(windows.accentEventListeners.size).toBe(0)
  })

  it('degrades to a no-op unsubscribe when the host cannot subscribe', () => {
    const { deps } = createDeps({
      subscribeNotification: () => {
        throw new Error('unsupported')
      }
    })
    const source = createSystemAccentColorSource(deps)
    expect(() => source.watch(vi.fn())()).not.toThrow()
  })
})
