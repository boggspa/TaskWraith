import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProductChangelogSnapshot } from '../../../main/store/types'
import type { UpdateStateSnapshot, UpdateStatus } from '../../../main/UpdateService'

export type SidebarQuickUpdateAction = 'download' | 'install' | 'check' | 'openChangelog' | 'none'

export function resolveSidebarQuickUpdateAction(
  status: UpdateStatus | undefined
): SidebarQuickUpdateAction {
  if (status === 'available') return 'download'
  if (status === 'downloaded') return 'install'
  if (status === 'error') return 'check'
  if (status === 'downloading') return 'openChangelog'
  return 'none'
}

export type ChangelogUpdateStatus = {
  snapshot: UpdateStateSnapshot | null
  busy: boolean
  checkForUpdates: () => Promise<UpdateStateSnapshot | null>
  downloadUpdate: () => Promise<UpdateStateSnapshot | null>
  downloadUpdateAndRestart: () => Promise<UpdateStateSnapshot | null>
  installUpdateNow: () => Promise<UpdateStateSnapshot | null>
}

export function shouldAutoOpenChangelog(
  snapshot: ProductChangelogSnapshot | null,
  appVersion: string
): boolean {
  if (!snapshot || appVersion === 'unknown') return false
  if (snapshot.pendingUpdateChangelog?.version !== appVersion) return false
  if (snapshot.lastSeenChangelogVersion === appVersion) return false
  return true
}

export function shouldMarkChangelogSeenOnDismiss(
  snapshot: ProductChangelogSnapshot | null,
  appVersion: string
): boolean {
  const pendingVersion = snapshot?.pendingUpdateChangelog?.version
  if (!pendingVersion || pendingVersion !== appVersion) return false
  if (snapshot?.lastSeenChangelogVersion === appVersion) return false
  return true
}

export function useChangelog(
  appVersion: string,
  updateStatus: ChangelogUpdateStatus
): {
  showChangelogSheet: boolean
  changelogSnapshot: ProductChangelogSnapshot | null
  handleOpenChangelogSheet: () => void
  handleDismissChangelogSheet: () => void
  handleSidebarQuickUpdate: () => void
} {
  const [showChangelogSheet, setShowChangelogSheet] = useState(false)
  const [changelogSnapshot, setChangelogSnapshot] = useState<ProductChangelogSnapshot | null>(null)
  const autoChangelogOpenedRef = useRef(false)

  const refreshChangelogSnapshot =
    useCallback(async (): Promise<ProductChangelogSnapshot | null> => {
      try {
        const next = await window.api.changelogSnapshot()
        setChangelogSnapshot(next)
        return next
      } catch {
        return null
      }
    }, [])

  const handleOpenChangelogSheet = useCallback(() => {
    setShowChangelogSheet(true)
    void refreshChangelogSnapshot()
  }, [refreshChangelogSnapshot])

  useEffect(() => {
    void refreshChangelogSnapshot()
  }, [refreshChangelogSnapshot])

  useEffect(() => {
    if (autoChangelogOpenedRef.current) return
    if (!shouldAutoOpenChangelog(changelogSnapshot, appVersion)) return
    autoChangelogOpenedRef.current = true
    setShowChangelogSheet(true)
  }, [appVersion, changelogSnapshot])

  const handleDismissChangelogSheet = useCallback(() => {
    setShowChangelogSheet(false)
    if (!shouldMarkChangelogSeenOnDismiss(changelogSnapshot, appVersion)) return
    void window.api
      .markChangelogSeen(appVersion)
      .then((next) => setChangelogSnapshot(next))
      .catch(() => {})
  }, [appVersion, changelogSnapshot])

  const handleSidebarQuickUpdate = useCallback(() => {
    switch (resolveSidebarQuickUpdateAction(updateStatus.snapshot?.status)) {
      case 'download':
        void updateStatus.downloadUpdateAndRestart()
        break
      case 'install':
        void updateStatus.installUpdateNow()
        break
      case 'check':
        void updateStatus.checkForUpdates()
        break
      case 'openChangelog':
        handleOpenChangelogSheet()
        break
      default:
        break
    }
  }, [handleOpenChangelogSheet, updateStatus])

  return {
    showChangelogSheet,
    changelogSnapshot,
    handleOpenChangelogSheet,
    handleDismissChangelogSheet,
    handleSidebarQuickUpdate
  }
}
