import { useEffect, useRef } from 'react'
import {
  runApplicationMenuCommand,
  type ApplicationMenuActions
} from '../lib/applicationMenuActions'

export function useApplicationMenu(actions: ApplicationMenuActions, enabled = true): void {
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!enabled || !window.applicationMenu) return
    return window.applicationMenu.onCommand((command) => {
      void Promise.resolve()
        .then(() => runApplicationMenuCommand(command, latest.current))
        .catch((error) => console.error('[application-menu] Action failed:', error))
    })
  }, [enabled])
}
