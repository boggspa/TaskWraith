import { useEffect, useRef } from 'react'
import {
  runApplicationMenuCommand,
  type ApplicationMenuActions
} from '../lib/applicationMenuActions'

export function useApplicationMenu(
  actions: ApplicationMenuActions,
  enabled = true,
  onWindowFocus?: () => void
): void {
  const latest = useRef({ actions, onWindowFocus })
  latest.current = { actions, onWindowFocus }
  useEffect(() => {
    if (!enabled || !window.applicationMenu) return
    const unsubscribe = window.applicationMenu.onCommand((command) => {
      void Promise.resolve()
        .then(() => runApplicationMenuCommand(command, latest.current.actions))
        .catch((error) => console.error('[application-menu] Action failed:', error))
    })
    const refresh = (): void => latest.current.onWindowFocus?.()
    window.addEventListener('focus', refresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [enabled])
}
