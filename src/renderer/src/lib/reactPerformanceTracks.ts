/**
 * React 19 enables development Performance Tracks when both
 * `console.timeStamp` and `performance.measure` exist. Component measures can
 * include a structured clone of changed props, which is especially costly for
 * TaskWraith's multi-megabyte chat records.
 *
 * Keep React's other development checks, but hide the feature-detection hook
 * only while `react-dom/client` initializes. Production React does not install
 * these tracks. Set VITE_REACT_PERFORMANCE_TRACKS=1 for an explicit profiling
 * session.
 */

export function shouldDisableReactPerformanceTracks(
  isDevelopment: boolean,
  explicitOptIn: string | undefined
): boolean {
  return isDevelopment && explicitOptIn?.trim() !== '1'
}

type PropertyTarget = object & { timeStamp?: unknown }

function hideTimeStamp(target: PropertyTarget): (() => void) | null {
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(target, 'timeStamp')
  const descriptor = Object.getOwnPropertyDescriptor(target, 'timeStamp')

  try {
    if (descriptor && !descriptor.configurable) {
      if (!('value' in descriptor) || !descriptor.writable) return null
      const originalValue = descriptor.value
      target.timeStamp = undefined
      if (typeof target.timeStamp === 'function') return null
      return () => {
        target.timeStamp = originalValue
      }
    }

    Object.defineProperty(target, 'timeStamp', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: undefined
    })
    if (typeof target.timeStamp === 'function') return null
  } catch {
    return null
  }

  return () => {
    if (hadOwnProperty && descriptor) {
      Object.defineProperty(target, 'timeStamp', descriptor)
    } else {
      delete target.timeStamp
    }
  }
}

export async function loadWithoutReactPerformanceTracks<T>(
  loader: () => Promise<T>,
  timingConsole: PropertyTarget = console
): Promise<T> {
  const restore = hideTimeStamp(timingConsole)
  try {
    return await loader()
  } finally {
    restore?.()
  }
}
