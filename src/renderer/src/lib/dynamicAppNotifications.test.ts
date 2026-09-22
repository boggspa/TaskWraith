import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publishDynamicAppNotifications,
  readDynamicAppNotifications,
  resetDynamicAppNotificationsForTests,
  subscribeDynamicAppNotifications,
  type DynamicAppNotification
} from './dynamicAppNotifications'

const notice: DynamicAppNotification = {
  id: 'dyn-1',
  kind: 'warning',
  title: 'Stack recovery paused',
  body: 'Stack a: refused.'
}

afterEach(() => {
  resetDynamicAppNotificationsForTests()
})

describe('dynamicAppNotifications', () => {
  it('starts empty and hands back a frozen, stable snapshot', () => {
    expect(readDynamicAppNotifications()).toEqual([])
    expect(readDynamicAppNotifications()).toBe(readDynamicAppNotifications())
    publishDynamicAppNotifications([notice])
    const snapshot = readDynamicAppNotifications()
    expect(snapshot).toEqual([notice])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(readDynamicAppNotifications()).toBe(snapshot)
  })

  it('notifies subscribers once per publish and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeDynamicAppNotifications(listener)

    publishDynamicAppNotifications([notice])
    expect(listener).toHaveBeenCalledTimes(1)

    publishDynamicAppNotifications([])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(readDynamicAppNotifications()).toEqual([])

    // Clearing an already-empty set is not a change.
    publishDynamicAppNotifications([])
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    publishDynamicAppNotifications([notice])
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
