import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { TaskWraithPluginActivationSnapshot } from '../../../../shared/plugins/PluginTypes'

export interface UsePluginActivationResult {
  pluginActivation: TaskWraithPluginActivationSnapshot | null
  setPluginActivation: Dispatch<SetStateAction<TaskWraithPluginActivationSnapshot | null>>
  refreshPluginActivation: () => Promise<void>
}

export function usePluginActivation(
  initialState: TaskWraithPluginActivationSnapshot | null = null
): UsePluginActivationResult {
  const [pluginActivation, setPluginActivation] =
    useState<TaskWraithPluginActivationSnapshot | null>(initialState)

  const refreshPluginActivation = useCallback(async (): Promise<void> => {
    if (typeof window.api?.getPluginActivation !== 'function') return
    try {
      setPluginActivation(await window.api.getPluginActivation())
    } catch {
      setPluginActivation(null)
    }
  }, [])

  useEffect(() => {
    const handlePluginActivationChanged = (): void => {
      void refreshPluginActivation()
    }
    window.addEventListener('taskwraith-plugin-activation-changed', handlePluginActivationChanged)
    return () =>
      window.removeEventListener(
        'taskwraith-plugin-activation-changed',
        handlePluginActivationChanged
      )
  }, [refreshPluginActivation])

  return { pluginActivation, setPluginActivation, refreshPluginActivation }
}
