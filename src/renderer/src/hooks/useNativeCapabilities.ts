import { useEffect, useState } from 'react'
import type { NativeCapabilitySnapshot } from '../../../main/NativeCapabilities'

export function deriveEnsembleConcurrentLanesAvailable(
  nativeCapabilities: NativeCapabilitySnapshot | null
): boolean {
  return nativeCapabilities?.featureGates?.concurrentLanes ?? true
}

export function deriveEnsembleConcurrentWriteLanesAvailable(
  nativeCapabilities: NativeCapabilitySnapshot | null
): boolean {
  return nativeCapabilities?.featureGates?.concurrentWriteLanes ?? true
}

export function deriveScreenWatchUnavailableReason(
  nativeCapabilities: NativeCapabilitySnapshot | null
): string | null {
  return nativeCapabilities && !nativeCapabilities.screenWatch.available
    ? nativeCapabilities.screenWatch.reason || 'Appwatch/Appshots are macOS-only in v1.'
    : null
}

export function useNativeCapabilities(): {
  nativeCapabilities: NativeCapabilitySnapshot | null
  ensembleConcurrentLanesAvailable: boolean
  ensembleConcurrentWriteLanesAvailable: boolean
  screenWatchUnavailableReason: string | null
} {
  const [nativeCapabilities, setNativeCapabilities] = useState<NativeCapabilitySnapshot | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    const nativeCapabilityLoad = window.api.getNativeCapabilities?.()
    if (!nativeCapabilityLoad) return
    void nativeCapabilityLoad.then((snapshot) => {
      if (!cancelled) setNativeCapabilities(snapshot)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return {
    nativeCapabilities,
    ensembleConcurrentLanesAvailable: deriveEnsembleConcurrentLanesAvailable(nativeCapabilities),
    ensembleConcurrentWriteLanesAvailable:
      deriveEnsembleConcurrentWriteLanesAvailable(nativeCapabilities),
    screenWatchUnavailableReason: deriveScreenWatchUnavailableReason(nativeCapabilities)
  }
}
