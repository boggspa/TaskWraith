import { describe, expect, it, vi } from 'vitest'
import {
  loadWithoutReactPerformanceTracks,
  shouldDisableReactPerformanceTracks
} from './reactPerformanceTracks'

describe('shouldDisableReactPerformanceTracks', () => {
  it('disables tracks by default only in development', () => {
    expect(shouldDisableReactPerformanceTracks(true, undefined)).toBe(true)
    expect(shouldDisableReactPerformanceTracks(false, undefined)).toBe(false)
  })

  it('allows an explicit development profiling opt-in', () => {
    expect(shouldDisableReactPerformanceTracks(true, '1')).toBe(false)
    expect(shouldDisableReactPerformanceTracks(true, ' 1 ')).toBe(false)
  })
})

describe('loadWithoutReactPerformanceTracks', () => {
  it('hides timeStamp while the module loads and restores its descriptor', async () => {
    const timeStamp = vi.fn()
    const timingConsole = { timeStamp }
    const descriptorBefore = Object.getOwnPropertyDescriptor(timingConsole, 'timeStamp')

    const result = await loadWithoutReactPerformanceTracks(async () => {
      expect(timingConsole.timeStamp).toBeUndefined()
      return 'loaded'
    }, timingConsole)

    expect(result).toBe('loaded')
    expect(timingConsole.timeStamp).toBe(timeStamp)
    expect(Object.getOwnPropertyDescriptor(timingConsole, 'timeStamp')).toEqual(descriptorBefore)
  })

  it('removes a temporary shadow and restores an inherited timeStamp', async () => {
    const inheritedTimeStamp = vi.fn()
    const timingConsole = Object.create({ timeStamp: inheritedTimeStamp }) as {
      timeStamp?: unknown
    }

    await loadWithoutReactPerformanceTracks(async () => {
      expect(timingConsole.timeStamp).toBeUndefined()
    }, timingConsole)

    expect(Object.prototype.hasOwnProperty.call(timingConsole, 'timeStamp')).toBe(false)
    expect(timingConsole.timeStamp).toBe(inheritedTimeStamp)
  })

  it('restores timeStamp when module loading rejects', async () => {
    const timeStamp = vi.fn()
    const timingConsole = { timeStamp }

    await expect(
      loadWithoutReactPerformanceTracks(async () => {
        throw new Error('load failed')
      }, timingConsole)
    ).rejects.toThrow('load failed')

    expect(timingConsole.timeStamp).toBe(timeStamp)
  })
})
