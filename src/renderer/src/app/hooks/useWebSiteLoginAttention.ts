import { useEffect, useState } from 'react'
import {
  countWebSiteLoginsNeedingAttention,
  type WebSiteLogin
} from '../../../../shared/webSiteLogin'

export function useWebSiteLoginAttention(): number {
  // Saved sessions that have gone stale. TaskWraith cannot re-authenticate for
  // the user, so the one thing it owes them is saying which site needs them -
  // surfaced as a badged Work > Logins tab rather than a modal, because this is
  // never urgent enough to interrupt what they are doing.
  const [webSiteLoginAttention, setWebSiteLoginAttention] = useState(0)
  useEffect(() => {
    const api = window.api as unknown as {
      listWebSiteLogins?: () => Promise<Array<{ status?: WebSiteLogin['status'] }>>
      onWebSiteLoginsChanged?: (callback: () => void) => () => void
    }
    if (!api?.listWebSiteLogins) return
    let active = true
    const refreshAttention = (): void => {
      void api
        .listWebSiteLogins?.()
        .then((sites) => {
          if (!active) return
          setWebSiteLoginAttention(countWebSiteLoginsNeedingAttention(sites))
        })
        .catch(() => {})
    }
    refreshAttention()
    const unsubscribe = api.onWebSiteLoginsChanged?.(refreshAttention)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])
  return webSiteLoginAttention
}
